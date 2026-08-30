# Runbook — process roles, grupos de scheduler e a volta ao monólito

> Issue #513. Cobre: **quem é cada processo**, **o que o scheduler roda**,
> **takeover de posse de linha**, **lease pendurada**, **pareamento durante
> takeover** e **rollback**.
>
> A posse de linha (lease + fencing token) é implementada em
> `src/gateway/channel-lease.ts` (fatias A/B da #513). Duplicata de ownership
> herdada da migration 091 é outro assunto:
> [`line-ownership-duplicates.md`](line-ownership-duplicates.md).

---

## 0. Descobrir o estado em 30 segundos

Tudo o que este runbook pergunta está no **primeiro log de cada container** e
em duas consultas. Comece por aqui antes de mexer em qualquer coisa.

```bash
# Quem é cada processo, o que ele INICIA e o que o /readyz EXIGE dele.
docker logs maia-app       2>&1 | grep -m1 maia.starting
docker logs maia-scheduler 2>&1 | grep -m1 maia.starting

# O que o scheduler agendou, o que ficou de fora, e o que duplica com 2 réplicas.
docker logs maia-scheduler 2>&1 | grep -m1 scheduler.inventory
docker logs maia-scheduler 2>&1 | grep -m1 scheduler.unguarded_jobs_enabled
```

`maia.starting` traz `role`, `owns` e `requires` — derivados de
`src/runtime/lifecycle/roles.ts`, não de prosa. `scheduler.inventory` traz
`groups_enabled`, `groups_disabled` (com a contagem de jobs de cada um) e a
lista nominal do que subiu.

**Sintoma que este bloco resolve sozinho:** "um job não roda". Em nove de dez
vezes o grupo dele está em `groups_disabled`, e a resposta é uma variável de
ambiente — não um debug.

---

## 1. Papéis (`MAIA_PROCESS_ROLE`)

| Papel | Inicia | `/readyz` exige | Uso |
|---|---|---|---|
| `all` | tudo | tudo | **o deployment de hoje**, e o alvo de rollback |
| `api` | HTTP, filas (produz) | HTTP, queue | control plane; não abre socket, não consome fila, não agenda cron |
| `worker` | fila (consome) | queue, agent_worker | cognition + tools; **escalável** |
| `scheduler` | cron | cron_scheduler | jobs periódicos |
| `session-owner` | Baileys + linhas | whatsapp_session, queue | transporte |

Valor fora do enum é **erro de boot**, nunca fallback permissivo
(`parseProcessRole`, fail-closed).

### 1.1 Separar roles em produção

```bash
# .env.infra
MAIA_PROCESS_ROLE=api      # <-- ISTO. Sem ele o `app` continua em `all`.

docker compose --env-file .env.infra -f compose.prod.yml \
  --profile split-roles up -d
```

> **O erro que custa caro:** subir `--profile split-roles` e esquecer
> `MAIA_PROCESS_ROLE=api`. O `app` fica em `all` e passam a existir **dois**
> schedulers e **dois** consumidores da fila. Confira com o grep de §0: os
> três containers têm que reportar papéis diferentes.

Escalar worker (o objetivo da issue — throughput sem socket a mais):

```bash
docker compose -f compose.prod.yml --profile split-roles up -d --scale worker=4
```

`scheduler` e `session-owner` **não** se escalam assim hoje — ver §2.3 e §3.

---

## 2. Grupos de jobs (`MAIA_SCHEDULER_GROUPS`)

Lista separada por vírgula, ou `all`. Vazio = o conjunto default. Nome
desconhecido **aborta o boot** — um typo não vira "grupo ignorado".

Inventário, classificação de concorrência e o default de cada grupo:
[`docs/architecture/modules/workers.md`](../architecture/modules/workers.md#grupos-e-o-que-aconteceu-com-phase).

### 2.1 Ligar um grupo desligado

Os cinco grupos `off` (`console`, `cognition`, `procedures`, `proactive`,
`governance`) são exatamente os jobs que o antigo `phase > 1` descartava em
silêncio. Ligar um é uma decisão de operação:

```bash
# .env.infra ou .env.app
MAIA_SCHEDULER_GROUPS=turn-pipeline,outbound,scheduling,channel,monitoring,housekeeping,ops-backup,cognition
docker compose -f compose.prod.yml up -d scheduler
docker logs maia-scheduler 2>&1 | grep -m1 scheduler.inventory   # confira
```

Antes de ligar, leia o que o grupo custa:

- `cognition` e `console` chamam **LLM** — o scheduler passa a precisar de
  `ANTHROPIC_API_KEY` (`src/runtime/lifecycle/role-config.ts`) e a conta diária
  sobe. Vigie `DAILY_LLM_USD_THRESHOLD` e o `cost_monitor`.
- `proactive` **escreve para o usuário** (briefings). Com duas réplicas de
  scheduler, o dono recebe dois bom-dia. Não ligue com scheduler escalado.
- `governance` abre **issue no GitHub** (`tool_request_issue_relayer`).

### 2.2 "O job X não rodou"

1. `grep scheduler.inventory` — o nome de X está em `jobs`?
   Não → o grupo dele está desligado. Fim.
2. Está na lista, mas nada acontece → a **flag** dele está off. Vários jobs são
   no-op na primeira linha por feature flag (`synthetic_probe` ↔
   `MAIA_SYNTHETIC_PROBE`, `mcp_sync` ↔ `FEATURE_MCP_TOOLS`,
   `outbound_recovery` ↔ `FEATURE_OUTBOUND_RECOVERY`). Grupo e flag são gates
   independentes.
3. Rodou e demorou → `maia_scheduler_job_lag_seconds{job="X"}` é a **idade do
   último sucesso**. Cresce sem parar ⇒ o job falha ou nunca completa; cruze
   com `maia_scheduler_job_total{job="X",result="failed"}` e
   `result="skipped_overlap"`.
4. `skipped_overlap` subindo ⇒ o tick anterior não terminou antes do próximo.
   Não é erro por si (o guard é deliberado), mas é sinal de saturação.

### 2.3 Duas réplicas de scheduler

**Não faça isso sem ler a lista de `scheduler.unguarded_jobs_enabled`.** Ela é
impressa em `warn` no boot e nomeia os jobs cujo efeito duplica com mais de uma
réplica. Com o conjunto default, os dois que importam são `pending_expirer` e
`workflow_engine_tick`: os dois cancelam aprovação vencida **e notificam o
solicitante por WhatsApp**, sem compare-and-swap. Duas réplicas ⇒ dois avisos
de expiração para a mesma aprovação.

O restante do registro é seguro por construção (row claim, advisory lock ou
idempotência), e cada job DECLARA qual — `src/workers/index.ts`.

---

## 3. Takeover de posse de linha

Uma linha tem no máximo um dono. A posse é uma lease com prazo do **relógio do
banco**, e cada nova posse incrementa um `fencing_token` monotônico.

### 3.1 O que é normal

| Evento | Métrica | Leitura |
|---|---|---|
| processo novo pega linha livre | `maia_channel_lease_acquire_total{result="acquired"}` | normal em deploy |
| dono renova | `..._heartbeat_total{result="renewed"}` | batimento; a ausência é o alarme |
| dono anterior sumiu | `maia_channel_lease_takeover_total{reason="lease_expired"}` | **esperado após crash**; um pico contínuo, não |
| shutdown limpo | `..._takeover_total{reason="released_by_owner"}` | deploy ordenado |
| dois processos disputam | `..._acquire_total{result="held_by_other"}` | normal: o perdedor desiste |
| processo velho tenta agir | `maia_channel_fence_rejected_total{operation="send"}` | **o fencing funcionando** |

`fence_rejected` em `send` é boa notícia — significa que um processo que perdeu
a posse foi impedido de enviar. Se ele aparecer **em rajada e continuamente**,
há um processo zumbi que não morreu: mate o container.

### 3.2 Takeover que não acontece (linha muda)

Sintoma: mensagens não entram nem saem de uma linha, e ninguém reporta erro.

1. Confirme que existe um dono e se a lease dele está viva
   (`session_owner_instance`, `session_owner_lease_expires_at` em
   `channel_line_state`).
2. `lease_expires_at` no passado e ninguém pegou ⇒ **não há session owner
   rodando** para aquele tenant. Confira `maia.starting` do container que
   deveria possuir (`owns` tem que conter `whatsapp_session`).
3. `lease_expires_at` no futuro e o dono não responde ⇒ processo pendurado.
   Espere a lease vencer (TTL de 30s) **antes** de subir outro; subir antes só
   produz `held_by_other` e ruído.

### 3.3 Lease pendurada (o dono morreu com a lease viva)

Não force nada nos primeiros 30 segundos: **é o prazo fazendo o trabalho
dele.** O takeover é permitido só depois da expiração, e é o banco que decide.

Só intervenha se, passado o TTL, ninguém assumiu **e** há um session owner
saudável no ar. Nesse caso o suspeito é uma lease de um `owner_instance` que
não existe mais e que ninguém está tentando reivindicar — por exemplo porque o
canal foi desativado. Reative o canal, ou desative-o de vez; **não** edite
`session_fencing_token` à mão: o token é o que protege as escritas, e
retrocedê-lo reabre a janela de split-brain que ele existe para fechar.

---

## 4. Pareamento durante takeover

O pareamento escreve **auth state**. Duas escritas simultâneas no mesmo auth
state corrompem a sessão, e é por isso que o console (que só tem Postgres)
**não** pareia: ele grava um comando durável em `channel_line_state` e o
`channel_pairing` (grupo `channel`, cadência de 5s) reivindica com
`FOR UPDATE SKIP LOCKED` e executa no processo que tem o socket.

Regras de operação:

1. **Não pareie durante um takeover.** Espere `maia.starting` do novo dono e
   uma renovação de heartbeat antes de clicar em parear.
2. Se o QR não aparece: confira se o grupo `channel` está habilitado no
   processo que possui a linha (`scheduler.inventory`). Sem ele, o comando
   fica na tabela para sempre e o console mostra "pendente" — a UI está
   dizendo a verdade sobre um worker que não existe.
3. QR e código de 8 dígitos **não** são logados nem auditados (saem cifrados).
   Não tente recuperá-los do log; peça outro pareamento.

---

## 5. Rollback — voltar ao monólito

O caminho de volta é **um comando**, e é assim de propósito.

```bash
# 1. Derrube os processos separados (o profile é opt-in: sem ele, não sobem).
docker compose -f compose.prod.yml --profile split-roles \
  stop scheduler worker
docker compose -f compose.prod.yml --profile split-roles \
  rm -f scheduler worker

# 2. Devolva o `app` ao modo compatível.
#    .env.infra:  MAIA_PROCESS_ROLE=all      (ou apague a linha: `all` é o default)
docker compose --env-file .env.infra -f compose.prod.yml up -d app

# 3. Confirme, sem adivinhar.
docker logs maia-app 2>&1 | grep -m1 maia.starting        # role: all
docker logs maia-app 2>&1 | grep -m1 scheduler.inventory  # os crons voltaram
```

Ordem importa: **derrube o scheduler ANTES** de devolver o `app` para `all`.
Invertido, existe uma janela com dois schedulers — que é o pior dos dois
mundos, e o motivo de o passo 1 vir primeiro.

Para posse de linha, o rollback tem uma exigência a mais da issue: garanta que
os session owners distribuídos **liberaram** as leases antes de subir o
monólito. Um shutdown ordenado já faz isso
(`takeover_total{reason="released_by_owner"}`); se você matou os containers com
`kill -9`, espere o TTL da lease vencer antes do passo 2.

O que **não** faz parte do rollback: mexer em `session_fencing_token`, apagar
`channel_session_leases`, ou voltar ao envio direto por socket a partir de um
processo que não é o dono. As tabelas de posse permanecem durante toda a janela
de rollback — é isso que mantém os dois lados compatíveis.

---

## 6. Referências

| O quê | Onde |
|---|---|
| Contrato de papéis (`owns` / `requires`) | `src/runtime/lifecycle/roles.ts` |
| Least privilege por papel | `src/runtime/lifecycle/role-config.ts` + `tests/unit/runtime/lifecycle/role-config.spec.ts` |
| Registro e classificação dos jobs | `src/workers/index.ts`, `src/workers/job-contract.ts` |
| Teste de arquitetura do registro | `tests/unit/workers/job-contract.spec.ts` |
| Posse de linha (lease + fence) | `src/gateway/channel-lease.ts` |
| Deploy de produção | [`deploy-prod.md`](deploy-prod.md) |
| Config que não valida no boot | [`config-contract.md`](config-contract.md) |
