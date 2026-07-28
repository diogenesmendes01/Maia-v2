# Maia — runbook operacional

Cenários comuns + ações concretas. Fluxo: detecte (alerta? log? métrica?) → diagnostique → mitigue → registre.

> **Antes de qualquer ação destrutiva**, snapshot do DB: `npm run backup` (ou aguardar o `nightly_backup` 03:00 BRT — ver `src/workers/backup.ts`).

---

## 1. WhatsApp pareou? Como verificar / re-parear

**Sinal**: `/health/whatsapp` retorna `{ ok: false }`, métrica `maia_baileys_connected=0`, ou audit `whatsapp_disconnected` repetido.

**Diagnóstico rápido**:

```bash
ssh maia 'tail -50 /var/log/maia.log | grep baileys'
# Procurar: 'baileys.connection_closed', 'baileys.logged_out', 'setup.recovery_*'
```

**Caso 1 — disconnect transiente** (Wi-Fi/celular caiu): processo religa sozinho em ~5s. Espere 30s e cheque de novo. Se persistir, vá pro Caso 2.

**Caso 2 — LoggedOut**: o auto-recovery deveria ter rotacionado o token e mandado alerta. Se você não recebeu o alerta:

```bash
ssh maia 'cat .baileys-auth/control/setup-token.txt'   # NOVO token (já rotacionado pelo recovery)
# Browser → https://maia.SEU-DOMINIO.com/setup
# A página pede o token: COLE no formulário (o token vai no corpo do POST).
# Clique "QR" ou "Código de 8 dígitos"
```

> **Issue #518 — o token NÃO vai mais na URL.** `/setup?token=…` não autentica
> mais: a URL ficava no histórico do navegador, no header `Referer` e no
> access log do nginx. O token é colado uma vez no formulário e trocado por um
> cookie de sessão `httpOnly` + `SameSite=Strict` válido por 30 minutos.
> Rotacionar o token revoga as sessões abertas.
>
> Break-glass para automação/curl (sem browser), com o token em HEADER:
>
> ```bash
> TOKEN=$(ssh maia 'cat .baileys-auth/control/setup-token.txt')
> curl -s -H "x-maia-setup-token: $TOKEN" https://maia.SEU-DOMINIO.com/setup/status
> ```

**Caso 3 — recovery travou**: verifique no `audit_log` se `pairing_recovery_started` apareceu sem `pairing_recovery_completed`:

```sql
SELECT acao, created_at FROM audit_log
WHERE acao IN ('pairing_recovery_started', 'pairing_recovery_completed')
ORDER BY created_at DESC LIMIT 10;
```

Se travou, SSH manual:

```bash
ssh maia
sudo systemctl stop maia
rm -rf /opt/maia/.baileys-auth
sudo systemctl start maia
# Aguarde 'setup.bootstrap_token_ready' no log, depois fluxo normal de /setup.
```

**Audit log relacionado**: `pairing_recovery_started`, `pairing_recovery_completed`, `pairing_logged_out`, `setup_token_rotated`.

> Quando a PR #24 (audit_watcher) for mergeada, a regra `pairing_recovery_stuck` dispara alerta automático após 1 min sem `_completed`.

---

## 2. WhatsApp rate-limit (banimento temporário do número Maia)

**Sinal**: erros `too many requests` ou `connection refused` repetidos do socket Baileys, mensagens não saem.

**Mitigação**:

1. **Reduzir tráfego de saída imediatamente**: `FEATURE_OUTBOUND_VOICE=false`, `FEATURE_PDF_REPORTS=false`, `FEATURE_PROACTIVE_MESSAGES=false` no `.env`, restart.
2. **Pausar workers que mandam mensagem**: edite `src/workers/index.ts`, pule `briefing_*` e qualquer worker que faça `sendOutbound*`.
3. **Espere 24-48h** sem tráfego de saída. WhatsApp não publica curva de unban; fica observando.
4. **Re-pareie** quando voltar (provável que o número precise re-parear).

**Prevenção**: hard limit em `RATE_LIMIT_MSGS_PER_HOUR` (default 30) já protege incoming. Pra outgoing não há limit estruturado — se ficar vendo padrões, criar `OUTBOUND_RATE_LIMIT_PER_HOUR` é um bom follow-up.

---

## 3. LLM provider down (Anthropic, OpenAI, Voyage)

**Sinal**: audit `llm_circuit_opened` aparecendo, métrica `maia_llm_calls_total{status="error"}` crescendo, mensagens demorando ou falhando.

**Diagnóstico**:

```sql
-- Ver quantos circuit breakers abriram nas últimas horas:
SELECT acao, count(*), max(created_at) FROM audit_log
WHERE acao IN ('llm_circuit_opened', 'llm_circuit_closed')
  AND created_at > NOW() - INTERVAL '6 hours'
GROUP BY acao;
```

**Mitigação**:

1. **Confirmar é o provider**: `curl -i https://api.anthropic.com/v1/health` (Anthropic) ou `curl -i https://openrouter.ai/api/v1/health` (OpenRouter), sem auth.
2. **Workaround imediato (LLM_PROVIDER=openrouter)**: troque o modelo no admin-ui em `/setup/llm-settings` (requer role `founder` — model switch é high-blast-radius, audited atomicamente). Se o main estava num provider down (ex: `anthropic/...`), pula pra outro (ex: `openai/gpt-5`, `google/gemini-2.5-pro`, `x-ai/grok-4.1-fast`). Próxima mensagem usa o modelo novo, sem restart, **para TODOS os tenants e agents** — o pick fica em `global_settings` (process-wide, não escopado por tenant/agent; ver migration 062). A mudança aparece em `admin_audit_log` com `action='llm_model_changed'` e o `change_summary` carrega `{ before, after, comment }` que o operador forneceu. Concurrent founders são serializados via `SELECT ... FOR UPDATE` na linha de `global_settings`, garantindo que `before` no audit reflete o que realmente persistiu sob o lock (não um snapshot stale).
3. **Workaround imediato (LLM_PROVIDER=anthropic)**: edite `LLM_PROVIDER=openrouter` no `.env` + setup `OPENROUTER_API_KEY`, restart. Funcionalmente equivalente ao circuit breaker, mais flexível.
4. **Sem fallback configurado**: o circuit breaker já está aberto, agente responde "estou processando, volte em alguns minutos" (graceful). Aguarde provider voltar.
4. **Cost spike** durante outage (retries): o `cost-monitor` cron pega no dia seguinte (alerta `Daily LLM cost USD…above…`).

**Audit log relacionado**: `llm_circuit_opened`, `llm_circuit_closed`.

> Quando a PR #24 (audit_watcher) for mergeada, a regra `llm_circuit_long_open` dispara alerta após 5 min sem `_closed`.

---

## 4. DB connection lost / Postgres down

**Sinal**: `/health/db` em down, log `pg pool error`, queries falhando em massa.

**Mitigação**:

1. **Identificar a causa**: `ssh maia 'sudo systemctl status postgresql'`. OOM? Disk full?
2. **Restart simples**: `sudo systemctl restart postgresql`. App reconecta sozinho via pool.
3. **Disk full**: `df -h /var/lib/postgresql`. Limpe: `vacuum full` em tabelas grandes (`audit_log`, `mensagens`). Cuidado — bloqueia acesso durante o vacuum.
4. **Restore se corrompido**: ver §6.

> Não há gauge `maia_db_connected` registrado hoje (`src/server.ts` só registra `maia_redis_connected` e `maia_baileys_connected`). Use `/health/db` ou observação dos logs `pg pool error`. Adicionar o gauge é um follow-up trivial se quiser alarme automático.

---

## 5. DLQ — jobs no dead-letter queue

**Sinal**: alerta de `dlq_job_added`, log `agent.job.failed` repetido.

**Inspeção**:

```bash
ssh maia 'cd /opt/maia && npm run dlq -- list'
# Lista até 50 entradas abertas com id, queue, attempts, error, created_at.
```

**Resolução**:

- **Erro determinístico** (parsing inválido, dado corrompido): registre o `id` da DLQ, depois marque resolvido (não re-enfileira):
  ```bash
  npm run dlq -- resolve <id>
  ```
- **Erro transient** (timeout LLM, rede): re-enfileira no agent queue + marca resolvido:
  ```bash
  npm run dlq -- retry <id>
  ```
- **Padrão recorrente**: investigue o código — provavelmente um bug, não um job ruim.

**Audit log relacionado**: `dlq_job_added`, `dlq_job_resolved`.

---

## 6. Restore de backup (drill ou recuperação real)

**Drill** (sem afetar produção):

```bash
ssh maia 'cd /opt/maia && npm run restore:test'
# Pega o backup mais recente, restaura num DB efêmero, valida count(pessoas), drop.
# Audit: 'restore_test_passed' ou 'restore_test_failed'.
```

**Recuperação real** (DB original perdido/corrompido):

1. **Pare o app**: `sudo systemctl stop maia`.
2. **Identifique o dump**: `ls -la /opt/maia/backups/maia-*.dump | tail`.
3. **Recrie o DB**: `sudo -u postgres dropdb maia && sudo -u postgres createdb maia`.
4. **Restore**: `sudo -u postgres pg_restore --no-owner -d maia /opt/maia/backups/maia-2026-XX-XX-XX-XX-XX.dump`.
5. **Migrações em cima** (se mudou schema entre backup e agora): `npm run db:migrate`.
6. **Inicie**: `sudo systemctl start maia`. Confira `/health/db`.

**Janela de perda**: até 24h (backup é nightly). Pra perda menor: snapshots EBS / volume cloud = follow-up.

---

## 7. Setup token rotation manual

**Quando**: você suspeita que o token vazou (auditoria mostra `setup_unauthorized_access` repetido — ou, depois da PR #23, `setup_csrf_mismatch`).

```bash
ssh maia 'cd /opt/maia && rm -f .baileys-auth/setup-token.txt && sudo systemctl restart maia'
# Próximo boot: ensureToken() recria o arquivo + audit 'setup_token_rotated reason=cold_start'.
ssh maia 'cat /opt/maia/.baileys-auth/setup-token.txt'   # NOVO token
```

**Importante**: o token da sessão (Baileys) é diferente do bootstrap token (`/setup`). Rotacionar o bootstrap NÃO desconecta o WhatsApp.

> Quando a PR #24 (audit_watcher) for mergeada, as regras `setup_unauthorized_farm` (3+ em 5min) e `setup_csrf_attack` (5+ em 5min) disparam alerta automático.

---

## 8. Métricas pra ficar de olho

```bash
curl -s http://localhost:3000/metrics | grep -E "maia_(baileys|redis|llm|audit)_"
```

| Métrica (registrada hoje) | Tipo | Alerta se |
|---|---|---|
| `maia_baileys_connected` | gauge | =0 por > 2min |
| `maia_redis_connected` | gauge | =0 por > 30s |
| `maia_llm_calls_total{status="error"}` | counter | rate alto |
| `maia_llm_tokens_total{kind=...}` | counter | rate alto = custo |
| `maia_llm_latency_ms` | histogram | p99 > 30s |
| `maia_audit_events_total{action,tenant_id,agent_id}` | counter | crescimento súbito em ações sensíveis (filtrável por tenant) |

> Adicionar `maia_llm_circuit_state` é um follow-up trivial (uma linha em `src/server.ts` via `setGaugeProvider`). Se quiser alertas baseados nessa, abre uma PR.

### 8.1 Probes — qual endpoint usar onde (issue #512)

Quatro superfícies com **contratos diferentes**. Apontar o probe errado para o
endpoint errado transforma queda de dependência em restart loop.

| Endpoint | Pergunta que responde | Faz I/O? | Usar em |
|---|---|---|---|
| `/livez` | o processo está vivo? | **não** (nenhum) | liveness do orquestrador / `healthcheck` do compose |
| `/startupz` | a inicialização terminou? | não | startup probe |
| `/readyz` | o load balancer deve mandar tráfego? | sim, read-only e cacheado | readiness probe / pool do LB |
| `/health`, `/health/{db,redis,whatsapp}` | qual componente está ruim? | sim, read-only e cacheado | diagnóstico humano, dashboards |

Não há `/health/llm` — use `maia_llm_calls_total{status}` no Prometheus.

Regras que o código garante (`src/runtime/lifecycle/`):

- **`/livez` nunca toca DB, Redis, WhatsApp ou disco.** Um `/health` como
  liveness fazia o container ser reiniciado quando o Postgres caía — o
  processo estava perfeitamente vivo.
- **`/readyz` é role-aware** (`MAIA_PROCESS_ROLE`, ver §8.2) e **fail-closed**:
  503 enquanto `starting`, `draining`, `failed` ou `stopped`, e 503 se um
  componente obrigatório do papel estiver `down`/`unknown` (DB, Redis,
  pressão de memória do Redis, versão de schema, fila/worker, sessão).
- **`/readyz` vira 503 no primeiro request depois do SIGTERM** — o estado é
  checado antes (e fora) do cache.
- **Nenhum probe escreve.** Antes do #512 cada chamada de `/health` inseria 3
  linhas em `system_health_events`; a série histórica agora é escrita pelo cron
  `health_monitor` (1×/min).
- **Nenhum probe devolve texto cru de driver** (`details` é removido na borda
  HTTP; a mensagem completa vai só para o log).

> **Cold start / pareamento.** Nos papéis que exigem a sessão (`all`,
> `session-owner`), o primeiro `connection.update = open` real — e não o
> retorno de `startBaileys()` — é o marco de "subiu". Até ele acontecer:
>
> - `whatsapp_session` fica `starting`;
> - o lifecycle fica em `starting` (não vai para `ready`);
> - **`system_started` NÃO é auditado** — a trilha não pode dizer que o sistema
>   subiu num instante em que ele não atendia;
> - `/startupz` e `/readyz` respondem **503**;
> - `/livez` responde 200 (o processo está vivo) e o log emite
>   `lifecycle.still_waiting_for_component` a cada 30s.
>
> O `/setup` continua acessível (é rota HTTP, fora dos gates), então o fluxo de
> QR/código funciona normalmente — acesse o host diretamente, não pelo pool do
> load balancer. **Não** aponte um startup probe com `failureThreshold` curto
> para `/startupz` num host que ainda vai ser pareado: o probe mataria o pod
> antes de alguém conseguir escanear o QR. Use `/livez` para liveness (é o que
> o `compose.prod.yml` faz).
>
> A espera é interrompível: um SIGTERM durante o pareamento aborta o boot e
> drena limpo (`maia.startup_aborted_by_shutdown`).
>
> Depois do primeiro `open`, uma queda de socket vira `degraded` e a instância
> **permanece** em rotação (anti-flapping); um `loggedOut` vira `failed` e tira
> de rotação, porque aí a sessão realmente acabou e exige novo pareamento.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/livez     # 200 sempre que o processo responde
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/startupz  # 503 → boot ainda em andamento
curl -s http://localhost:3000/readyz | jq '.ready, .state, .role, (.checks[] | select(.required))'
```

> As variáveis desta seção vivem no contrato de configuração (#515): grupo
> **Lifecycle do processo** em `src/config/contract.ts`, documentadas em
> [`docs/configuration.md`](../configuration.md). As relações entre elas são
> regras executáveis em `src/config/rules.ts` — `npm run config:check` avisa,
> por exemplo, se `SHUTDOWN_STEP_TIMEOUT_MS` ficar maior que
> `SHUTDOWN_GRACE_MS`.

### 8.2 Papel do processo (`MAIA_PROCESS_ROLE`)

Contrato em `src/runtime/lifecycle/roles.ts`. Hoje todo processo roda `all`
(modo compatível). Os demais papéis existem para a separação de topologia
(issue #513) e já mudam o que `/readyz` exige:

| Papel | Inicia | `/readyz` exige |
|---|---|---|
| `all` | tudo | tudo |
| `api` | HTTP + filas (produtor) | config, db, schema, redis, redis_memory, queue, http |
| `worker` | filas + worker BullMQ | config, db, schema, redis, redis_memory, queue, agent_worker |
| `scheduler` | crons | config, db, schema, redis, redis_memory, cron_scheduler |
| `session-owner` | sessões WhatsApp + filas | config, db, schema, redis, redis_memory, queue, whatsapp_session |

Valor desconhecido = erro de boot (fail-closed), nunca fallback permissivo.

### 8.3 Métricas de lifecycle

| Métrica | Tipo | Alerta se |
|---|---|---|
| `maia_lifecycle_state{role,state}` | gauge | `state="failed"`=1, ou `state="draining"`=1 por > grace |
| `maia_lifecycle_transition_total{role,from,to}` | counter | transições para `failed` |
| `maia_readiness_check_total{component,result}` | counter | `result!="ok"` sustentado |
| `maia_readiness_check_duration_ms{component}` | histogram | p99 perto do `READINESS_PROBE_TIMEOUT_MS` |
| `maia_shutdown_total{result,role}` | counter | `result="incomplete"` |
| `maia_shutdown_duration_ms{component}` | histogram | passo perto do `SHUTDOWN_STEP_TIMEOUT_MS` |
| `maia_shutdown_forced_total{reason,role}` | counter | **qualquer** incremento |
| `maia_shutdown_undrained_startup_total{step}` | counter | **qualquer** incremento (fase de boot travada; recurso pode ter ficado aberto) |
| `maia_worker_active_jobs{worker}` | gauge | =1 continuamente (job travado) |
| `maia_worker_last_success_timestamp{worker}` | gauge | idade > 3× a cadência do cron |
| `maia_worker_last_failure_timestamp{worker}` | gauge | recente + sem sucesso depois |
| `maia_worker_tick_skipped_total{worker,reason}` | counter | crescimento (execução anterior não termina no intervalo) |

---

## 9. Restart limpo (zero data loss)

```bash
sudo systemctl stop maia          # SIGTERM → inicia o drain
# Log esperado, nesta ordem:
#   maia.shutting_down
#   lifecycle.transition            from=ready to=draining
#   queue.workers_paused
#   lifecycle.shutdown_step_done    step=stop_accepting_work
#   lifecycle.shutdown_step_done    step=cron_workers
#   lifecycle.shutdown_step_done    step=bullmq
#   lifecycle.shutdown_step_done    step=background_tasks
#   lifecycle.shutdown_step_done    step=turn_context_subscriber
#   lifecycle.shutdown_step_done    step=line_sessions
#   lifecycle.shutdown_step_done    step=baileys
#   lifecycle.shutdown_step_done    step=http
#   lifecycle.shutdown_step_done    step=pools
#   lifecycle.shutdown_complete     result=clean
sudo systemctl start maia
# Aguarde 'http.listening' → 'maia.ready' e /readyz respondendo 200
```

**O que o shutdown faz de verdade**
(`src/runtime/lifecycle/shutdown-sequence.ts`, `registerShutdownSequence`):

0. transição atômica para `draining` → `/readyz` responde 503 no request
   seguinte, e o guard de trabalho novo (`lifecycle.isAcceptingWork()`) fecha
   no mesmo tick do sinal;
1. **para de aceitar trabalho** (`stop_accepting_work`, primeiro passo, sem
   esperar nada): pausa os dois Workers BullMQ (`pause(true)` — para de
   *buscar*) e para de agendar crons. Um job que já estava sendo entregue ao
   processor é reestacionado como `delayed`, não executado;
2. **espera** o tick de cron em execução (antes ele só chamava `task.stop()` e
   seguia em frente, fechando os pools por baixo do job);
3. fecha BullMQ — `Worker.close()` **espera o job ativo terminar**. Vem
   ANTES do WhatsApp para que um turno em voo ainda consiga responder;
4. espera as tarefas fire-and-forget rastreadas (reflection pós-turno, escrita
   de DLQ, registro de linha) — depois da fila e dos crons, que são quem as
   gera;
5. fecha o subscriber de invalidação do cache de contexto do turno (#511). Ele
   tem conexão ioredis PRÓPRIA (o ioredis proíbe outros comandos num cliente
   inscrito), então o `pools` do passo 9 não a cobre; deixá-la aberta segurava
   o event loop e disparava o backstop de saída a cada deploy limpo;
6. fecha as linhas adicionais e depois a sessão Baileys primária (cancelando o
   timer de reconexão pendente);
7. fecha o Fastify (dispara os `onClose`: timers do coletor de memória e do probe de DB);
8. audita `system_stopped`;
9. fecha Redis e Postgres **por último** (nenhum consumidor fica com handle fechado);
10. sai naturalmente. Não há `process.exit(0)` prematuro.

**SIGTERM durante o boot** é tratado: cada fase do startup roda sob
`lifecycle.runStartupStep`, que aborta o boot no primeiro checkpoint após o
sinal e serializa contra o shutdown (nada é fechado enquanto ainda está sendo
aberto). O log mostra `maia.startup_aborted_by_shutdown` e **não** há
`system_start_failed` — sinal durante deploy não é incidente.

Se a fase de boot **não ceder** dentro de `SHUTDOWN_STEP_TIMEOUT_MS`, o drain
não espera para sempre — mas também **não** se declara limpo: a fase entra em
`undrained` como `startup:<fase>` (log
`lifecycle.shutdown_startup_step_did_not_yield`, counter
`maia_shutdown_undrained_startup_total{step}`), o outcome vira `incomplete` e
o processo sai com `SHUTDOWN_FORCED_EXIT_CODE`. O motivo é concreto: um
`startServer()`/`startBaileys()` que retorna DEPOIS do passo que o fecharia
deixaria listener ou socket vivo num processo que já se disse parado — a saída
forçada entrega ao SO o que não foi possível fechar.

**Orçamento de tempo** — `SHUTDOWN_GRACE_MS` (default 25s) é o teto do drain
inteiro e `SHUTDOWN_STEP_TIMEOUT_MS` (default 10s) o de cada passo. Ele
**precisa ser menor** que o `TimeoutStopSec` do systemd / `stop_grace_period`
do compose (40s no `compose.prod.yml`), senão o SIGKILL corta o drain.

**Quando o deadline estoura:** os componentes não drenados aparecem em
`lifecycle.shutdown_incomplete` (campo `undrained`), o counter
`maia_shutdown_forced_total{reason="drain_deadline"}` incrementa e o processo
sai com `SHUTDOWN_FORCED_EXIT_CODE` (default 1). Trabalho não concluído
continua recuperável: o job BullMQ volta como stalled e a row de inbound
pendente é re-enfileirada pelo `message_recovery`.

**Segundo SIGTERM/SIGINT** força a saída imediata — é auditado
(`system_shutdown_forced`) e metrificado
(`maia_shutdown_forced_total{reason="second_signal_SIGTERM"}`). Use só se o
drain travou.

**Se o boot falhar** (dependência obrigatória fora): não há readiness, o
lifecycle vai para `failed`, `system_start_failed` é auditado, o que já abriu é
fechado e o processo sai com 1. Redis indisponível **não** é mais um warning
silencioso.

Restart preserva: sessão Baileys (`.baileys-auth/`), backups, audit log, jobs
(BullMQ persiste em Redis).

---

## 10. Checklist de deploy novo (cold start)

- [ ] `.env` preenchido e validado — `npm run config:check` (fonte da verdade: `ENV_CONTRACT` em `src/config/contract.ts`; referência gerada em [`docs/configuration.md`](../configuration.md))
- [ ] Postgres + Redis up (`/health/db` + `/health/redis`)
- [ ] `npm run db:migrate` rodado
- [ ] `npm run build` clean
- [ ] App started → log mostra `setup.bootstrap_token_ready` (cold start, sem `creds.json`)
- [ ] SSH cat `.baileys-auth/control/setup-token.txt` → abrir `/setup` no browser → colar o token no formulário (nunca na URL) → escolher QR ou código → parear com WhatsApp do número da Maia
- [ ] Linhas ADICIONAIS: parear pelo Admin (`/setup/channels`), não pelo `/setup` — o console é autenticado e a auditoria fica com o ator administrativo (issue #518)
- [ ] Audit log mostra `system_started`, `pairing_qr_displayed` (ou `pairing_code_requested`), `pairing_completed`
- [ ] `/health/whatsapp` ok
- [ ] Mande mensagem teste pro número Maia → log mostra `baileys.message.enqueued` → resposta do agente em ~3-8s
- [ ] (Opcional) Configurar nginx (uma vez que a PR #23 land, ver `docs/runbooks/setup-nginx.md`): IP whitelist, TLS, fail2ban

---

## Apêndice — referências cruzadas

- **`docs/runbooks/redis.md`** — política de memória multi-tenant, sizing, sinais de pressão. Leia ANTES de mexer em `maxmemory*` no compose ou no Redis gerenciado.
- **`docs/runbooks/setup-nginx.md`** — IP whitelist, TLS, fail2ban (PR #23, ainda não mergeada na escrita deste runbook).
- **`audit_watcher`** — regras automáticas de detecção de anomalia (PR #24, ainda não mergeada). Mencionado em §1, §3, §7.
- **`scripts/restore-test.ts`** — drill de restore (já no main).
- **`src/workers/backup.ts`** — backup nightly (já no main).
- **`src/workers/cost-monitor.ts`** — alerta de custo LLM diário acima de `DAILY_LLM_USD_THRESHOLD` (já no main).
- **`src/workers/health-monitor.ts`** — vigilância dos health checks (já no main).

Quando #23 e #24 mergearem, este runbook continua válido — as referências forward (marcadas com `>`) viram links concretos sem alterar nenhum comando.
