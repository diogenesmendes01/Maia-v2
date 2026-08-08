# Runbook — saga de onboarding (issue #519)

Como retomar, diagnosticar, cancelar e reverter uma run de provisionamento.
Contexto e desenho: [`docs/architecture/modules/onboarding.md`](../architecture/modules/onboarding.md).

Três tabelas: `onboarding_runs` (estado corrente), `onboarding_events`
(histórico append-only) e `onboarding_step_results` (ledger de idempotência).
Nenhuma delas guarda segredo, telefone, e-mail ou QR — se você precisa desses
dados para diagnosticar, você está olhando o lugar errado (veja
`channel_line_state` para pareamento, `admin_audit_log` para quem fez o quê).

## 1. "Onde está a run?"

```sql
SELECT id, kind, tenant_id, agent_id, state, current_step, version,
       last_error_code, created_by, expires_at
  FROM onboarding_runs
 WHERE state NOT IN ('active','cancelled','failed_terminal')
 ORDER BY updated_at DESC;
```

O histórico de UMA run, na ordem em que aconteceu:

```sql
SELECT created_at, step, event_type, from_state, to_state, actor_id, summary
  FROM onboarding_events
 WHERE run_id = :run_id
 ORDER BY created_at;
```

Leitura dos `event_type`:

| Evento | Significa |
|---|---|
| `step_completed` | o passo commitou (recurso + ledger + evento + auditoria, juntos) |
| `step_replayed` | retry com a MESMA chave; o resultado veio do ledger, nada re-executou |
| `step_denied` | o BACKEND recusou (readiness reprovado, papel ausente, escopo divergente). Não é bug |
| `step_failed` | falha de infraestrutura |
| `run_expired` | a varredura de TTL encerrou a run |

### A trilha administrativa de uma run — cuidado com o bucket `system`

`admin_audit_log.tenant_id` é FK para `tenants(id)`, e os primeiros eventos de
uma run acontecem **antes** de `provision_tenant` criar o tenant. Essas linhas
ficam no bucket `system`, com o alvo pretendido em
`change_summary.target_tenant_id`. **Filtrar só por `tenant_id` perde o começo
da história.** A consulta certa cobre os dois:

```sql
SELECT created_at, action, tenant_id, actor_id,
       change_summary->>'target_tenant_id' AS alvo,
       change_summary->>'step'             AS passo
  FROM admin_audit_log
 WHERE tenant_id = :tenant
    OR change_summary->>'target_tenant_id' = :tenant
 ORDER BY id;
```

Por run (mais direto, e usa `admin_audit_log_resource_idx`):

```sql
SELECT created_at, action, tenant_id, change_summary
  FROM admin_audit_log
 WHERE resource_type = 'onboarding_run' AND resource_id = :run_id
 ORDER BY id;
```

As três decisões agente-escopadas (`agent_readiness_evaluated`,
`agent_activation_approved|denied`) vão para `audit_log`, não para
`admin_audit_log`, e com `alvo_id` nulo — o agente está em `audit_log.agent_id`
e em `metadata->>'agent_id'`.

## 2. Retomar

Uma run é retomável por construção: o estado está no banco, não em memória.
Reinício de API, de worker ou de deploy não perde nada.

Para retomar, o operador precisa de **três coisas**: o `run_id`, a `version`
atual e o próximo passo legal. Os passos legais a partir do estado corrente
vêm do backend — `getOnboardingRun` devolve `allowed_steps`. Não deduza a lista
lendo esta página; ela pode ficar velha, o backend não.

```
executeOnboardingStep({ run_id, step, payload, idempotency_key, expected_version, actor })
```

**A chave de idempotência é conservada até um resultado conclusivo.** Se você
não sabe se o comando anterior commitou, repita com a MESMA chave: ou ele roda
(nada tinha commitado) ou volta `replayed: true` com o resultado persistido.
Gerar uma chave nova nessa situação é o erro clássico — você recebe
`invalid_transition` e fica sem saber o que aconteceu.

### Sintomas e o que fazer

| Sintoma | Causa | Ação |
|---|---|---|
| `version_conflict` | outro operador (ou outra aba) avançou a run | Releia a run, confira o estado e refaça com a `version` nova |
| `idempotency_payload_mismatch` | a mesma chave foi reusada com outro payload | Gere uma chave nova **para a nova intenção**. Se o payload antigo era o certo, repita-o com a chave antiga |
| `invalid_transition` | o passo não é legal a partir do estado atual | Leia `allowed_steps`. Normalmente o passo já commitou |
| `run_expired` | passou de `expires_at` | Cancele e abra uma run nova. Os recursos já criados permanecem |
| `readiness_blocked` | checks bloqueantes vermelhos | Cada check traz `remediation`. Corrija e rode `evaluate_readiness` de novo |
| `run_terminal` | `active` / `cancelled` / `failed_terminal` | Runs terminais não são retomadas. Abra uma nova |
| `pairing_in_progress` | já há pareamento vivo (ou um abort pendente) nessa linha | A run foi para `failed_retryable`. Aborte o pareamento anterior no console de linhas e rode `start_pairing` de novo |
| `duplicate_tenant` (em `startOnboardingRun`) | já existe uma saga VIVA para esse tenant, aberta com outra chave | Retome a run existente (`listOnboardingRuns`) ou cancele-a. Ver §2.1 |
| `activation_precondition_failed` | a configuração mudou entre a avaliação e a escrita: ou não sobrou nenhuma linha integralmente válida, ou o conjunto válido **divergiu** do que o readiness aprovou | A run está em `readiness_failed` e **nada foi escrito** (agente segue `provisioning`, canais seguem inativos). Confira `channel_policies`, o papel padrão e `channel_line_state` do par e rode `evaluate_readiness` de novo |

### 2.1 `failed_retryable`: só o passo que FALHOU volta a ser legal

Uma run em `failed_retryable` guarda **onde parou**, em duas colunas:

```sql
SELECT id, state, failed_step, resume_state, last_error_code
  FROM onboarding_runs WHERE id = '<run_id>';
```

- `failed_step` — o passo que o backend recusou. É ele (e só ele) que pode ser
  reexecutado, mais as remediações declaradas para ele;
- `resume_state` — o estado de onde aquele passo partiu, para diagnóstico.

`getOnboardingRun().allowed_steps` já devolve exatamente esse conjunto: **use a
lista do backend**, não deduza. Hoje a única remediação declarada é
`confirm_channel_ready → start_pairing` (refazer o pareamento da MESMA linha).

Se `allowed_steps` vier **vazio** com a run em `failed_retryable`, a run é
irretomável (não há `failed_step` gravado — só runs anteriores à migration 113
conseguem estar nesse estado): cancele-a e abra uma nova. Os recursos já
provisionados permanecem.

Por que não é possível "voltar um passo": `provision_tenant`, `provision_admin`,
`declare_channel` e afins reexecutados fora de ordem duplicam governança
(segundo admin, segundo canal) ou rebobinam o estado materializado. O backend
responde `invalid_transition` e **nada roda** — o passo nem chega à escrita.

### 2.2 Abrir a saga também é idempotente

```
startOnboardingRun({ kind, tenant_id, actor, idempotency_key, metadata })
→ { status: 'started', run, replayed }   |   { status: 'conflict', code, message }
```

- `replayed: true` ⇒ a run já existia e é **a sua** (mesma chave). Nenhuma
  segunda run, nenhum segundo evento, nenhuma segunda linha de auditoria.
- `idempotency_payload_mismatch` ⇒ a mesma chave foi usada para abrir uma run
  **diferente** (outro tenant, outro kind, outro `metadata`). Gere uma chave nova
  para a nova intenção.
- `duplicate_tenant` ⇒ existe outra saga viva para o tenant, aberta com outra
  chave. O banco garante isso com dois índices parciais complementares:
  `onboarding_runs_one_live_per_tenant_uq` (run viva **sem** agente) e
  `onboarding_runs_one_live_per_agent_uq` (run viva por par completo).

#### A fase inicial é serializada por tenant, e isso é intencional

Antes de existir `agent_id`, **só pode haver uma saga viva por tenant**. Não é
um limite acidental do índice: antes do `provision_agent` não existe identidade
estável que distinga "um segundo agente legítimo" de "a mesma intenção enviada
duas vezes". Na dúvida entre duplicar um provisionamento e serializar, o
desenho serializa.

Depois do `provision_agent`, o índice passa a ser por `(tenant_id, agent_id)` e
**o paralelismo entre agentes do mesmo tenant volta a existir**. Ou seja: o
gargalo dura exatamente o trecho em que ele protege alguma coisa.

**Remediação de `live_run_exists`** — o operador recebe este código ao tentar
abrir a segunda saga. Na ordem:

1. **Ache a run viva.** `SELECT id, kind, state, created_at, agent_id FROM
   onboarding_runs WHERE tenant_id = $1 AND state <> ALL(<terminais>)`. Se
   `agent_id IS NOT NULL`, o bloqueio não é este — releia `duplicate_tenant`
   acima.
2. **Decida o que ela é.** Se for a *sua* intenção reenviada, não abra nada:
   retome com a chave original (§2) e o replay devolve a run materializada.
3. **Se for uma intenção diferente** (outro agente para o mesmo tenant), a run
   corrente precisa **avançar até `provision_agent`** — aí o índice deixa de
   colidir e a segunda saga abre normalmente.
4. **Se a run viva estiver abandonada**, cancele-a (§4) ou deixe o
   `onboarding_expirer` expirá-la (§5). Só depois abra a nova.

**Não remova o índice para "destravar".** Ele é a única proteção contra
provisionar duas árvores para o mesmo tenant. Se o paralelismo na fase inicial
virar requisito real, a solução é reservar um `agent_id`/draft identity **na
criação** — dando à segunda saga a identidade estável que hoje ela não tem —
e não afrouxar a garantia contra duplicatas.

`metadata` é um contrato **fechado**: `source` (`console|cli|api|automation`),
`intent` opcional (`new_tenant|reonboarding|migration|evaluation`) e
`ticket_ref` opcional no formato `ABC-123`. Qualquer outra chave é recusada com
`invalid_scope` — não existe campo de texto livre aqui, de propósito (o valor
seria persistido em `onboarding_runs.metadata`).

## 3. Readiness reprovado

`evaluate_readiness` leva a run a `readiness_failed` e devolve o relatório com
`code` + `message` + `remediation` por check. É o MESMO relatório que o
`maia doctor` mostra e que a ativação reavalia — não existe um segundo critério.

Os vermelhos mais comuns num onboarding novo:

| Check | Remediação |
|---|---|
| `profile_active` | aprove e ative a versão do profile (o passo `configure_profile` faz isso) |
| `default_role_resolved` | exatamente UM papel `is_default` + `active`. Dois papéis default é ambiguidade, não redundância |
| `channel_policy_role_active` | **nenhum** canal governado tem política apontando para papel ativo. Reative o papel ou reaponte a política |
| `channel_ownership_proven` | **nenhum canal satisfaz os três predicados AO MESMO TEMPO** (política + papel ativo + posse). A mensagem NOMEIA os canais governados excluídos e o que faltou em cada um — leia `readiness.channels[]` para o veredito por canal. Dois canais "cobrindo" predicados diferentes NÃO valem: a conjunção é por canal |
| `schema_ready` | **leia a mensagem antes de rodar migrate** — ver §3.1 |
| `governance_no_blocking_pending` | há alerta de drift `critical` sem `resolved_at` para o agente |
| `agent_exists` / `agent_belongs_to_tenant` | os dois vermelhos juntos = **não existe agente com esse id neste par**. O readiness NÃO diz se ele existe em outro tenant (seria vazamento de existência) — ver §3.2 |

### 3.1 `schema_ready` vermelho: `npm run db:migrate` nem sempre é a resposta

O check consome o veredito canônico de `src/migrations/`
([runbook de migrations](migrations.md)), não uma contagem de pendentes. A
mensagem traz os **códigos de bloqueador** e o id da migration:

| Bloqueador | O que aconteceu | Ação |
|---|---|---|
| `schema_below_minimum` | migration realmente pendente | `npm run db:migrate` |
| `dirty_migration` | uma migration `-- maia:no-transaction` morreu no meio; o schema pode estar parcial | **NÃO** rode migrate. Inspecione e use `migrate repair` — ver o runbook de migrations |
| `running_migration` | há `running` no ledger: ou um migrator está rodando agora, ou um caiu | Espere; se persistir, é debris de crash |
| `checksum_mismatch` | uma migration já aplicada foi EDITADA (migrations são append-only) | Descubra qual commit a editou. Nunca "conserte" alterando o ledger |
| `checksum_unknown` | aplicada por um runner antigo, sem checksum registrado | `migrate up` / `migrate backfill` adota o checksum empacotado |
| `missing_file` | **o banco aplicou algo que este build não empacota** — um deploy mais novo já migrou este banco | Não sirva tráfego deste build. Promova a versão que empacota a migration |

`state: 'unknown'` (banco fora do ar, ledger ilegível) também reprova, por
desenho: um erro de leitura nunca vira "schema pronto".

O `schema_fingerprint` gravado na auditoria da ativação cobre o **estado
verificado** de cada migration (estado + checksum), não a lista de ids — dois
carimbos iguais significam mesmo schema *e* mesma integridade.

### 3.2 "Esse agente existe em algum lugar?"

O readiness responde **só sobre o par requisitado**: agente de outro tenant é
indistinguível de agente inexistente, de propósito (invariante 1 do `AGENTS.md`;
confirmar existência a quem tem o id é vazamento entre tenants).

Quando o diagnóstico global é realmente necessário, ele existe numa fronteira
separada — restrita ao papel global `founder` e **auditada**:

```ts
import { diagnoseAgentOwnershipGlobally } from '@/onboarding/index.js';
await diagnoseAgentOwnershipGlobally({
  scope: { tenant_id, agent_id },
  actor: { actor_id, actor_role: 'founder' },
  reason_code: 'suporte-ticket-1234',
});
// => { verdict: 'absent' | 'owned_by_requested_tenant' | 'owned_by_other_tenant', owner_tenant_id? }
```

Toda chamada grava `admin_audit_log` no bucket `system` com ator, alvo e
veredito. Para auditar quem varreu ids:

```sql
SELECT created_at, actor_id, change_summary
  FROM admin_audit_log
 WHERE action = 'onboarding_agent_ownership_diagnosed'
 ORDER BY id DESC;
```

Depois de corrigir, rode `evaluate_readiness` novamente — é um passo repetível
e é assim que o ciclo corrigir→reavaliar funciona.

## 4. Cancelar

```
cancelOnboardingRun({ run_id, expected_version, actor, reason_code, idempotency_key })
```

O que o cancelamento faz: encerra a run em `cancelled`, grava o motivo em
`last_error_code` e registra evento + auditoria.

**`idempotency_key` é obrigatória**, como em qualquer comando mutável. Se você
não sabe se o cancelamento commitou, repita com a MESMA chave: volta
`replayed: true` com o resultado anterior, e não `run_terminal`. O ledger vive em
`onboarding_step_results` sob o pseudo-passo `cancel_run`:

```sql
SELECT outcome_kind, outcome_code, created_at
  FROM onboarding_step_results
 WHERE run_id = '<run_id>' AND step = 'cancel_run';
```

**`reason_code` é vocabulário FECHADO** — hoje `operator_abort` (operador) e
`expired` (varredura de runs vencidas). Qualquer outra coisa é recusada com
`invalid_scope`, **antes** de qualquer escrita. Não é burocracia: o motivo é
persistido integralmente em `onboarding_runs.last_error_code`, no evento
append-only e em `admin_audit_log`, e enquanto ele era texto livre "cliente
+55… desistiu" entrava nas três. O valor persistido é agora o MESMO que vira
label de métrica — trilha e série contam a mesma história.

O que ele **não** faz: desprovisionar. Isso é deliberado. Nenhum recurso criado
pela saga é exclusivo dela — o tenant, o agente ou a linha podem já estar em uso
por outro caminho — e a issue proíbe compensação cega sobre recurso
compartilhado. Para remover um recurso, use a superfície própria dele (suspender
o tenant, desativar o canal), com a auditoria daquele caminho.

Auditoria e eventos **nunca** são apagados: `onboarding_events` tem
`ON DELETE RESTRICT` sobre a run justamente para tornar impossível apagar uma
run com histórico.

Uma run cancelada não volta. Abra uma nova — o índice parcial de "uma run viva
por (tenant, agente)" só considera estados não terminais, então isso é
permitido.

## 5. Runs abandonadas

`onboardingRunsRepo.expireStale()` marca `cancelled` com
`last_error_code='expired'` toda run passada de `expires_at`. Ela continua
legível e diagnosticável — nunca é apagada. O TTL default é 7 dias
(`DEFAULT_RUN_TTL_MS`).

Não há worker agendado chamando isso ainda; hoje é invocação manual ou por
tarefa operacional.

## 6. Rollback

A ordem importa.

1. **Pare as runs novas.** Não há feature flag ainda: bloqueie a superfície que
   chama `startOnboardingRun`.
2. **Verifique se alguma run ficou em `activating`** — é a checagem que a issue
   exige antes de qualquer rollback:

   ```sql
   SELECT id, tenant_id, agent_id, updated_at FROM onboarding_runs WHERE state = 'activating';
   ```

   Uma run aí significa ativação commitada parcialmente. Investigue
   `admin_audit_log` e `agents.status` antes de prosseguir.

   > Nota: desde a review do PR #541 a ativação trava o retrato
   > (`lockReadinessSnapshot`) e **confere o efeito** das suas escritas antes de
   > concluir. Não existe mais o caso "run `active` com zero canais ativados";
   > se a configuração mudar na janela, a run vira `readiness_failed` **sem
   > escrita parcial**. Uma run presa em `activating` continua sendo sinal de
   > crash, não de decisão.
3. **Não apague tabelas nem eventos.** Runs existentes continuam legíveis e
   podem ser concluídas ou canceladas normalmente — o módulo não altera nenhum
   caminho de provisionamento anterior.
4. **Antes de 109, reverta 113 se for o caso.**
   `migrations/113_onboarding_idempotent_creation_down.sql` derruba o ledger de
   criação, a unicidade do escopo inicial, o `outcome_kind` do ledger de passos e
   o ponto de retomada. Ele **apaga** as linhas de `onboarding_step_results` com
   `outcome_kind <> 'success'` de propósito: sem a coluna, uma negativa e um
   cancelamento seriam indistinguíveis de sucesso no replay — perder o replay de
   uma negativa é ruim, devolver "concluído" no lugar dela é pior. Meça o
   estrago antes:

   ```sql
   SELECT state, count(*) FROM onboarding_runs WHERE failed_step IS NOT NULL GROUP BY state;
   SELECT outcome_kind, count(*) FROM onboarding_step_results
    WHERE outcome_kind <> 'success' GROUP BY outcome_kind;
   ```

   Runs em `failed_retryable` perdem o ponto de retomada: cancele-as e reabra,
   não tente "consertá-las".
5. **Só então**, se realmente necessário, `migrations/109_onboarding_runs_down.sql`.
   Ele derruba as três tabelas e **não** desprovisiona nada: tenants, agentes,
   profiles, papéis, políticas e canais criados por uma run permanecem. O
   sistema volta ao provisionamento manual router-a-router.
6. **`migrations/110_agents_status_provisioning_down.sql` só depois disso**, e
   sabendo o que ele faz: agentes parados em `agents.status='provisioning'`
   viram `paused`, porque o vocabulário antigo não tem como dizer "em
   onboarding" e `active` colocaria em serviço um agente sem profile, sem papel
   padrão e sem política de canal. Confira antes quem seria afetado:

   ```sql
   SELECT id, tenant_id, updated_at FROM agents WHERE status = 'provisioning';
   ```

   A informação não se perde: `onboarding_runs` e `admin_audit_log`
   (`onboarding_agent_provisioned`) continuam contando a história.

O readiness canônico **não** precisa de rollback: ele é somente-leitura e não
substituiu nenhum cálculo anterior — o dashboard e o go-live checklist do
console continuam com a lógica que já tinham.

## 7. Pareamento: onde procurar o comando

Desde a review do PR #541 o `start_pairing` enfileira **dentro da transação do
passo**. Consequências operacionais:

- se o passo devolveu `conflict` (expirada, versão velha, transição ilegal,
  terminal), **não há comando na fila** — não procure por ele, e não "limpe"
  nada;
- se o passo devolveu `completed`, o comando está em `channel_line_state` do
  canal, com o `command_id` também no `result` do passo (e no ledger):

```sql
SELECT cls.state, cls.command, cls.command_id, cls.command_requested_at,
       cls.actor_id, cls.correlation_id
  FROM channel_line_state cls
 WHERE cls.channel_id = :channel_id;
```

- a trilha do enfileiramento (`onboarding_pairing_requested`, resource_type
  `channel`) e a do passo da saga (`onboarding_pairing_started`) estão no MESMO
  commit — se você vê uma sem a outra, é bug, não corrida.
