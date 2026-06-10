# objectives

**Path:** `src/objectives/`

**Purpose** — Work loop (issue #469): registry tipado de *kinds* de objetivo — perceptores (materializam tarefas idempotentes a partir do estado do mundo, deterministicamente) e executores (processam uma tarefa claimada). É a camada que transforma objetivos declarativos owner-aprovados em trabalho autônomo, sem o LLM jamais decidir "que trabalho existe".

## Key files

| Path | Role |
|---|---|
| `src/objectives/kinds.ts` | Registry `OBJECTIVE_KINDS` + contrato `ObjectiveKind` (perceive opcional / execute obrigatório) e o kind `manual` (v1) |

Entidades em `src/db/schema.ts` (`agent_objectives`, `objective_tasks` — migração 088); repos em `src/db/repositories/objective-repos.ts`; workers em `src/workers/objective-execute-worker.ts` (`objective_perceive` + `objective_execute`); superfície em `src/admin-ui/trpc/routers/objectives.ts` + aba "Objetivos" do agente.

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — repos com tenant+agent explícitos; execução sob `runWithTenantContext` derivado da row
- [Action layer](../concerns/action-layer.md) — executores só usam caminhos existentes (procedures/tools/scheduling); guardrails na spec §7
- Spec canônica: [`docs/superpowers/specs/2026-06-10-agent-work-loop-design.md`](../../superpowers/specs/2026-06-10-agent-work-loop-design.md)

## How to extend

| Need | Where |
|---|---|
| Novo kind (ex.: `inadimplencia`, v2) | Declarar em `kinds.ts` com perceive/execute; tarefas via `objectivesRepo.upsertTask` (idempotência por `natural_key`) |
| Exceção humana | Retornar `{ transition: 'waiting_human' }`; resolução via `objectives.resolveTask` (v2 vincula pending questions) |

## Tests

`tests/unit/objectives/kinds.spec.ts`, `tests/admin-ui/unit/objectives-router.spec.ts`.

---

| | |
|---|---|
| Last verified | 2026-06-10 |
| Re-verify when | novo kind no registry, mudança nas tabelas 088, ou na spec do work loop |
