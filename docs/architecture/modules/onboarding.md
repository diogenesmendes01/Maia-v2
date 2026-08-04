# onboarding

**Path:** `src/onboarding/`

**Purpose** — Provisiona um `(tenant, agente)` completo por uma **saga durável, retomável e idempotente**, e expõe o **readiness canônico** — a única resposta autorizada à pergunta "este agente pode operar?". Issue #519.

Duas coisas moram aqui e é útil separá-las desde já:

| | O que é | Quem consome |
|---|---|---|
| **Readiness** (`readiness.ts`) | Função pura + loader. Diz se um par está pronto, com códigos estáveis e remediation. | `maia doctor` (#517), a ativação da saga, dashboard, go-live checklist, `npm run setup` |
| **Saga** (`wizard.ts` + `provisioning.ts`) | Máquina de estados persistida que CRIA o par e sua governança. | Console administrativo, CLI |

O readiness é útil sozinho — um agente provisionado à mão continua sendo avaliado pelo mesmo contrato. A saga depende do readiness; o contrário não.

## Por que não estendemos `npm run setup`

`scripts/setup.ts` semeia **dados de domínio dentro de um tenant que já existe** (`self_state`, dona, entidades, contas, permissões do home `primary` da #323). Ele nunca criou tenant, agente, papel, política ou canal, e seu estado vive num `readline` — some no primeiro crash.

Construímos **ao lado**, não por cima:

- substituir quebraria `npm run setup` para a instalação single-tenant existente, que ainda precisa daquele seed;
- estender acoplaria uma saga de governança a um TTY — "persistido e retomável" e "prompt interativo" são requisitos incompatíveis.

O que `scripts/setup.ts` ganhou foi **uma linha de verdade**: no fim ele imprime o readiness canônico de `primary/primary` em vez de declarar `done` sem prova (`scripts/setup.ts` → `reportPrimaryReadiness`).

## Key files

| File | Role |
|---|---|
| `src/onboarding/readiness.ts` | **A API pública para #517.** Tipos, avaliador PURO e `evaluateAgentReadiness` |
| `src/onboarding/readiness-facts.ts` | Loader dos fatos (o único I/O do readiness) |
| `src/onboarding/state-machine.ts` | Estados, passos e transições. Puro |
| `src/onboarding/wizard.ts` | Orquestrador: escopo → RBAC → payload → idempotência → commit → métricas/auditoria |
| `src/onboarding/provisioning.ts` | As escritas de cada passo, todas recebendo o `tx` do passo + os schemas Zod |
| `src/onboarding/idempotency.ts` | Hash da chave, hash canônico do payload, decisão replay/conflito |
| `src/onboarding/scope.ts` | Guard fail-closed dos literais reservados |
| `src/onboarding/sanitize.ts` | Denylist de chave para as três colunas `jsonb` |
| `src/onboarding/errors.ts` | Códigos de erro estáveis |
| `src/db/repositories/onboarding-repos.ts` | `commitStep` — a transação curta que dá atomicidade à saga |
| `migrations/109_onboarding_runs.sql` | `onboarding_runs`, `onboarding_events`, `onboarding_step_results` |

## O contrato de readiness (para #517)

```ts
import { evaluateAgentReadiness } from '@/onboarding/index.js';

const r = await evaluateAgentReadiness({ tenant_id, agent_id });
// r.ready: boolean — true ⟺ todo check `blocking` passou
// r.checks: { code, status: 'pass'|'fail', severity: 'blocking'|'advisory', message, remediation }[]
// r.evaluated_at, r.configuration_fingerprint, r.schema_fingerprint
```

Escopo inválido (vazio, com whitespace, ou os literais `'default'`/`'system'`) **lança** `OnboardingError` — não devolve `ready:false`. Devolver um relatório para um escopo proibido convidaria a UI a renderizar "quase pronto" para um alvo que nunca pode existir.

**Não re-derive prontidão no CLI.** O requisito de #517 é explícito: o backend calcula, a partir do mesmo contrato que o runtime usa.

### Checks

| Código | Severidade | O que prova |
|---|---|---|
| `tenant_exists` / `tenant_enabled` | blocking | o tenant existe e está `active` |
| `agent_exists` / `agent_belongs_to_tenant` | blocking | separados de propósito: "não existe" e "é de outro tenant" são diagnósticos diferentes |
| `profile_active` | blocking | há profile operacional `active` DO MESMO par |
| `capability_grant_present` | blocking | existe `agent_tool_grants` do par |
| `required_packs_granted` | blocking | `BASE_AGENT_PACKS` ⊆ `granted_packs` |
| `tool_permissions_coherent` | blocking | nenhuma tool concedida E negada |
| `default_role_resolved` | blocking | **exatamente um** papel `is_default` + `active` |
| `channel_declared` | blocking | ≥1 canal não-sintético do par |
| `channel_policy_resolved` | blocking | política DO MESMO par apontando para esse canal |
| `channel_policy_role_active` | blocking | o `default_role_id` resolve para papel ativo do par |
| `channel_ownership_proven` | blocking | linha em `connected` ou `verified_offline` (#518) |
| `channel_online` | advisory | linha `connected` agora — socket caído se recupera sozinho |
| `schema_ready` | blocking | zero migrations pendentes (fail-closed: erro de leitura ⇒ reprova) |
| `governance_no_blocking_pending` | blocking | nenhum alerta de drift `critical` sem `resolved_at` |
| `agent_activated` | advisory | `agents.status='active'` — advisório porque readiness é a PRECONDIÇÃO da ativação |

### A propriedade central

O avaliador é puro e recebe os fatos com o **escopo dono embutido em cada objeto**. Ele não confia que o loader filtrou — ele **prova**, descartando todo objeto cujo par não seja o requisitado. Um fato de outro escopo é tratado como **ausente**, jamais como satisfeito. É o que mata o falso positivo "profile de A + canal de B ⇒ pronto" (`tests/unit/onboarding/readiness.spec.ts`).

### Fingerprints

- `configuration_fingerprint` — SHA-256 da projeção canônica de profile, grants, papéis, políticas e canais. **Não inclui `channels.external_id`** (é o telefone da linha, e o fingerprint aparece em auditoria).
- `schema_fingerprint` — SHA-256 da lista ordenada de migrations aplicadas.

## A saga

```
created → tenant_ready → admin_ready → agent_draft → profile_ready →
capabilities_ready → policy_ready → channel_declared → pairing_pending →
channel_ready → ready_for_activation → activating → active
```

Laterais: `readiness_failed`, `failed_retryable`, `failed_terminal`, `cancelled`.

**Desvio documentado da lista da issue.** A issue sugere `policy_ready → channel_declared`, mas `channel_policies.channel_id` é `NOT NULL` — a política não pode existir antes do canal. Então `configure_role` leva a `policy_ready` significando "o papel de governança existe, está ativo e é o default", e `declare_channel` materializa o canal **e** a política que o vincula àquele papel, na mesma transação. O nome do estado foi preservado (é contrato da issue).

### Idempotência: duas defesas, para dois modos de falha

1. **Mesma chave, retry** → o ledger (`onboarding_step_results`) devolve o resultado persistido. Cobre o crash entre o commit e a resposta.
2. **Chave diferente** (double-click com duas requisições) → a máquina de estados recusa: o passo só é legal a partir do seu estado de origem, e o commit anterior já avançou a run. As duas requisições serializam no `FOR UPDATE` e a segunda vê `invalid_transition`.

Por isso **não** existe unique em `(run_id, step)`: passos re-executáveis (`evaluate_readiness`, retomada de pareamento) precisam poder rodar de novo, e quem impede o provisionamento duplicado é o **estado**, não o ledger.

### Atomicidade — o que acontece se um passo morre no meio

`onboardingRunsRepo.commitStep` faz, numa transação SQL curta: trava a run (`FOR UPDATE`) → confere `version` → consulta o ledger → valida a transição **contra o estado travado** → executa a escrita do passo **no mesmo `tx`** → grava ledger + evento + `admin_audit_log` + novo estado.

- **Crash ANTES do commit** → nada aconteceu. A run continua no estado anterior; o retry com a mesma chave refaz o passo.
- **Crash DEPOIS do commit, antes da resposta** → o retry com a mesma chave encontra o ledger e devolve o resultado persistido (`replayed: true`), sem re-executar a escrita.

Não há estado intermediário que exija inspeção manual do banco.

**A única exceção é `start_pairing`**, que enfileira um comando para OUTRO processo (o worker de #518) e portanto não cabe na transação. Mitigação: o `command_id` é **derivado** de `(run_id, step, hash da chave)`, e o contrato de #518 é "mesma `command_id` ⇒ devolve a sessão existente". Um crash entre o enfileiramento e o commit é reparado pelo retry com a mesma chave.

### Concorrência

Optimistic: todo comando informa `expected_version`; o `UPDATE` casa com `version = $expected` **e** a run está travada com `FOR UPDATE`. Dois operadores no mesmo passo ⇒ um avança, o outro recebe `version_conflict`.

### Ativação

A ativação **reavalia** o readiness sob a trava da run — readiness verde há cinco minutos não autoriza ativar agora. Reprovando, a run vai para `readiness_failed` e a auditoria registra `agent_activation_denied`. Aprovando, o agente vira `active`, as linhas **governadas** (com política do mesmo par) passam a rotear, e a auditoria registra `agent_activation_approved` com os dois fingerprints.

O operador precisa **confirmar o par exato** (`confirm_tenant_id` / `confirm_agent_id`); divergência é recusada. É a defesa contra ativar o agente errado a partir de uma aba antiga do console.

## Patterns it follows

- **Escopo fail-closed antes de tudo** — `scope.ts` rejeita `'default'` e `'system'` como ALVO de provisionamento. `'primary'` é um tenant ordinário e passa. As mesmas regras existem como `CHECK` na migration 108: o guard devolve erro tipado, o banco é a última linha.
- **Auditoria atômica** — a trilha completa vai para `admin_audit_log` **no mesmo `tx`** do passo (mesmo desenho de `tenantsRepo.createWithAuditAtomic`). `audit_log` não serve para todos os passos: sua coluna `agent_id` é FK para `agents`, e metade da saga roda antes do agente existir. As decisões agente-escopadas (`agent_readiness_evaluated`, `agent_activation_approved|denied`) emitem **também** `audit()` pós-commit sob o ALS do par real.
- **Backend decide** — todo payload passa por Zod antes de qualquer escrita; a UI propõe.
- **Nada sensível persistido** — `sanitize.ts` redige por denylist de CHAVE (determinístico e auditável) em `metadata`, `summary` e `result`. Telefone, e-mail, QR, código de pareamento e token nunca entram.

## How to extend

| Need | Where |
|---|---|
| Novo check de readiness | Adicione o código a `READINESS_CHECK_CODES`, o fato a `ReadinessFacts`, o check a `evaluateReadinessFacts` e a leitura a `readiness-facts.ts`. O teste de contrato exige um check por código |
| Novo passo da saga | `ONBOARDING_STEPS` + `STEP_DEFINITIONS` (state-machine), schema em `STEP_PAYLOAD_SCHEMAS`, `apply*` em `provisioning.ts`, `case` no `switch` de `wizard.ts` |
| Novo estado | `ONBOARDING_STATES` **e** o `CHECK` de uma migration NOVA (108 está mergeada — migrations são append-only) |
| Trocar a fonte dos fatos | Injete `deps.loadFacts` em `evaluateAgentReadiness` |

## Public surface

| Consumed by | What |
|---|---|
| `maia doctor` (#517) | `evaluateAgentReadiness` — a fonte canônica de prontidão |
| `scripts/setup.ts` | mesma função, para reportar o readiness de `primary` no fim do seed |
| Console administrativo (a construir) | `startOnboardingRun`, `executeOnboardingStep`, `cancelOnboardingRun`, `getOnboardingRun`, `listOnboardingRuns` |
| `src/db/repositories/channel-line-state-repos.ts` | via `PairingPort` — o wizard enfileira o pareamento de #518, não o reimplementa |

## Known gaps

Verifique contra as issues antes de confiar nesta lista.

- **Bootstrap global (`kind='global_bootstrap'`) não implementado.** A coluna e o `CHECK` existem (migrations são append-only e adiar custaria outra migration), mas `startOnboardingRun` recusa esse kind com `kind_not_implemented`. Falta a credencial de uso único, o endpoint restrito e a invalidação atômica — a criação do primeiro admin ainda é a via documentada em `docs/admin-ui-deploy.md`.
- **Sem superfície de UI.** Não há router tRPC nem telas; o módulo é backend puro.
- **Compensação é conservadora.** O cancelamento encerra a run e preserva tudo; não desprovisiona. Nenhum recurso criado pela saga é exclusivo dela (um tenant/agente/canal pode já estar em uso por outro caminho), e compensação cega sobre recurso compartilhado é explicitamente proibida pela issue.
- **`tests/integration/onboarding-leak.spec.ts` ainda não está no script `test:leak`** — `package.json` estava fora do escopo da entrega que criou o módulo.

---

| | |
|---|---|
| Last verified | 2026-08-04 |
| Against `main` HEAD | `ce1f0f69` |
| Re-verify when | Older than 30 days; OR `src/onboarding/**` muda; OR uma migration nova toca `onboarding_*`; OR #517/#518 mudam o contrato consumido aqui |
