# objectives

**Path:** `src/objectives/`

**Purpose** — Work loop (issue #469): registry tipado de *kinds* de objetivo — perceptores (materializam tarefas idempotentes a partir do estado do mundo, deterministicamente) e executores (processam uma tarefa claimada). É a camada que transforma objetivos declarativos owner-aprovados em trabalho autônomo, sem o LLM jamais decidir "que trabalho existe".

## Key files

| Path | Role |
|---|---|
| `src/objectives/kinds.ts` | Registry `OBJECTIVE_KINDS` + contrato `ObjectiveKind` (perceive opcional / execute obrigatório) e o kind `manual` (v1) |

Entidades em `src/db/schema.ts` (`agent_objectives`, `objective_tasks` — migração 088, com lease/fencing na 138); repos em `src/db/repositories/objective-repos.ts`; workers em `src/workers/objective-execute-worker.ts` (`objective_perceive` + `objective_execute`); superfície em `src/admin-ui/trpc/routers/objectives.ts` + aba "Objetivos" do agente.

## Estado operacional — os workers nunca rodaram

`objective_perceive` e `objective_execute` estão no grupo `console` do contrato de schedulers (`src/workers/job-contract.ts`), e esse grupo nasce **desligado** no default de `MAIA_SCHEDULER_GROUPS` — o que reproduz exatamente o comportamento anterior, em que `startWorkers(1)` descartava em silêncio todo job de `phase > 1`. Consequência prática para quem lê este módulo: **o código destes dois workers nunca foi exercitado em produção**. Trate-o como não exercitado, não como testado. Ligar o grupo é decisão de operação, não de PR.

## Lease, fencing e reaper (migração 138, #469 fatia A)

O claim da 088 marcava `status='running'` e nada mais. Isso deixava três buracos, todos fechados agora:

| Buraco | Fechamento |
|---|---|
| SIGKILL/OOM/deploy entre o claim e a transição prendia a tarefa em `running` **para sempre** — e o índice parcial `objective_tasks_live_natural_key_uq` trata `running` como tarefa VIVA, então nem o perceptor podia recriá-la | `claimed_by`/`claimed_at`/`lease_expires_at` + `objectivesRepo.reclaimExpiredTaskLeases()`, chamado no início de cada tick do `objective_execute` |
| `transitionTask` escrevia só por `id` — sem predicado de tenant (invariante 1) e sem fencing | `tenant_id`/`agent_id` obrigatórios; `expect_claim_token` no caminho do worker; `expect_status` (CAS) no caminho do console |
| Reaper ingênuo reanimaria para sempre uma tarefa que derruba o processo | `claim_attempts` + teto: acima de `MAX_TASK_CLAIM_ATTEMPTS` a tarefa vai para `failed` com `lease_expired_after_N_claims`, não volta para a fila |

O reaper é **cross-tenant** por desenho (o processo que morreu podia ser o de qualquer tenant), no mesmo padrão do índice de lease vencida das migrações 114 e 131; o escopo por tenant continua valendo em toda leitura de console e em toda escrita.

Não há `heartbeat_at`: esta fatia não renova lease, e uma coluna assim afirmaria um sinal de vida que ninguém emite. Um kind de execução longa entra junto com o renovador.

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — repos com tenant+agent explícitos; execução sob `runWithTenantContext` derivado da row
- [Action layer](../concerns/action-layer.md) — executores só usam caminhos existentes (procedures/tools/scheduling); guardrails na spec §7
- Spec canônica: [`docs/superpowers/specs/2026-06-10-agent-work-loop-design.md`](../../superpowers/specs/2026-06-10-agent-work-loop-design.md)
- Lease/reaper: mesmo padrão de `occurrencesRepo.reclaimExpiredLeases` (`src/scheduling/repos.ts`)

## How to extend

| Need | Where |
|---|---|
| Novo kind (ex.: `cobranca_amigavel`, v2) | Declarar em `kinds.ts` com perceive/execute; tarefas via `objectivesRepo.upsertTask` (idempotência por `natural_key`) |
| Índice único novo em `objective_tasks` | `upsertTask` já declara alvo explícito no `ON CONFLICT` — mantenha-o. Sem alvo, o `DO NOTHING` engole a violação do índice NOVO e devolve `null`, que o chamador lê como "já existia" |
| Exceção humana | Retornar `{ transition: 'waiting_human' }`; resolução via `objectives.resolveTask` (v2 vincula pending questions) |

## Tests

`tests/unit/objectives/kinds.spec.ts`, `tests/admin-ui/unit/objectives-router.spec.ts`, `tests/unit/workers/objective-execute-lease.spec.ts` (call site do reaper e do fencing no worker), `tests/integration/objective-task-lease.spec.ts` (lease/fencing/teto/predicado de tenant contra Postgres real), `tests/integration/skip-locked-claims.spec.ts`, `tests/integration/playground-objectives-mcp-leak.spec.ts`.

---

| | |
|---|---|
| Last verified | 2026-08-30 |
| Re-verify when | novo kind no registry, mudança nas tabelas 088/138, decisão de ligar o grupo `console`, ou mudança na spec do work loop |
