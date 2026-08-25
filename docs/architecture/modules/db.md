# db

**Path:** `src/db/`

**Purpose** — Drizzle ORM schema, repositories, query helpers, and the tenant-isolation primitives (`tenant-context.ts`, `tenant-guard.ts`). The schema defines every table; repositories provide the typed query interface; the tenant-context + guard pair enforces `tenant_id + agent_id` scoping on every query. SQL migrations live in `migrations/` at the repo root, not under `src/db/`.

> **The migration runner is a separate module.** Since issue #516 the discovery, checksums, advisory lock, ledger and schema-readiness logic live in [`src/migrations/`](migrations.md) — `scripts/migrate.ts` is only a CLI over it. Anything that needs to know whether the schema is compatible calls `getSchemaReadiness()` from that module; it must never re-derive the answer by querying `schema_migrations` directly.

## Key files

| File | Role |
|---|---|
| `src/db/schema.ts` | Drizzle schema for all tables |
| `src/db/repositories.ts` | Aggregated repository functions (transactions, audit, conversations, etc.) |
| `src/db/repositories/turn-repos.ts` | `agentTurnsRepo` — única porta de escrita da máquina de estados do turno inbound (issues #503/#504, migrations 096/097/114). Toda transição é compare-and-swap sobre `state_version`; transição terminal escreve, na MESMA transação, a projeção de compatibilidade `mensagens.processada_em`. `tryClaimTurn` é o claim ATÔMICO (um `UPDATE ... WHERE ... RETURNING`, relógio do PostgreSQL) e `expected_claim_token` é o FENCE de toda gravação da tentativa — zero linhas com fence declarado vira `stale_claim`, distinto de `state_mismatch`. Vocabulário em [`src/runtime/turns/contract.ts`](runtime.md) e [`claim.ts`](runtime.md). |
| `src/db/repositories/runtime-trace-repos.ts` | `runtimeTraceRepo` — leitura tenant-scoped do Trace Explorer sobre `runtime_trace_envelopes`/`_bodies`. `listAttempts()` agrupa as tentativas de um turno e exige os TRÊS: `tenantId`, `rootTraceId` e o `turnoId` **assinado** (issue #535). Sem o `turnoId` ele falha fechado (`TraceAttemptScopeError`) em vez de agrupar só por `root_trace_id` — que é editável sem detecção numa linha v1 e permitiria enxertar a tentativa de um turno na cadeia de outro. Irmão cuja própria assinatura verifica como `invalid` é descartado e devolvido em `refused`, que o router audita. Ver [`concerns/governance-observability.md` §4.4a/§4.4b](../concerns/governance-observability.md). |
| `src/db/repositories/holidays-repo.ts` | Holiday repository |
| `src/db/repositories/holiday-entidades-repo.ts` | Per-entity holiday repository |
| `src/db/client.ts` | Postgres connection pool (`max: 10`, process-wide) + Drizzle init |
| `src/db/repositories/finance-repos.ts` | `entidadesRepo`, `contasRepo`, `entityStatesRepo`, … — includes `byIdsWithState`, the entity ⋈ state LEFT JOIN the turn-context loader reads |
| `src/db/tenant-context.ts` | `runWithTenantContext`, `tryGetCurrentContext`, `getCurrentContext`, `MissingTenantContextError` |
| `src/db/tenant-guard.ts` | `applyTenantGuard()` — query-builder helper that injects scoping predicates |
| `src/db/capability-risk.ts` | Capability risk scoring helper |

## The pool is shared, and one caller must not take all of it

`pool` in `src/db/client.ts` opens `max: 10` connections **for the whole
process** — every tenant, every turn, every worker. A repository that fans out,
or a caller that issues its whole read set in one tick, does not just make
itself faster: it converts the pool into a queue for everybody else. Two numbers
therefore need reviewing together whenever either moves:

| Where | Number | Meaning |
|---|---|---|
| `src/db/client.ts:8` | `max: 10` | total connections in the process |
| `src/agent/turn-context/types.ts` | `TURN_CONTEXT_MAX_CONCURRENT_READS = 6` | most one agent turn may hold at once |

The agent turn is the hot path that hits this, so the ceiling lives with it and
is enforced by a shared FIFO semaphore in `src/agent/turn-context/concurrency.ts`
(background and rationale: [`agent`](agent.md#concurrency-ceiling)). A new
batched read on this path is a change to that budget, not just to a repository.

## Batched reads: bound the side that was bounded before

A `LIMIT` on a joined read is a contract, not a safety net, and folding two
reads into one JOIN does **not** let you fold their bounds. `entidadesRepo.byIdsWithState`
learned this the hard way (issue #525, PR #541 review): it replaced
`entidadesRepo.byIds` (never limited) plus `entityStatesRepo.byIds(ids, 500)`
(limited) with a single LEFT JOIN carrying one `LIMIT 500` over the merged rows.
Entities past row 500 disappeared entirely, and the prompt rendered their UUIDs
where names belong.

Two rules follow, and both are asserted in
`tests/integration/turn-context-scope-cardinality.spec.ts`:

1. **Each side of a JOIN keeps the cardinality it had.** `byIdsWithState` now
   returns every entity (bounded only by `ids.length`, which the caller
   controls) and caps only the state projection; a capped row comes back as
   `state: null`, indistinguishable from an entity that has no state row — the
   shape callers already handle.
2. **A truncation that reaches a non-truncatable surface is a bug, not a
   budget.** The scope/permissions block has no `SECTION_BUDGETS` entry on
   purpose. Silently dropping rows that feed it is a governance failure wearing
   a performance costume.

Tenant predicates survive both rules: on a LEFT JOIN the `(tenant_id, agent_id)`
predicate for the joined table belongs in the **JOIN condition**, never the
`WHERE`. `entity_states`'s PK is `entidade_id` alone, so a foreign state row
exists for an owned id; in the `WHERE` it would drop the whole row and turn a
foreign STATE into a missing ENTITY, which is the same name-loss bug by another
route.

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — `runWithTenantContext` + `applyTenantGuard` are the canonical scoping mechanism
- Migrations are append-only: new `<n>_<name>.sql` files in `migrations/`; never edit a merged file. Since #516 this is enforced, not just documented — the runner records a checksum per applied migration and blocks (`up`, `status` and readiness all fail) when a merged file's content changes. See [`migrations`](migrations.md).

## How to extend

| Need | Where |
|---|---|
| Add a table | (1) New migration in `migrations/` with `_up` and `_down`; (2) Schema definition in `schema.ts`; (3) Repository functions in `repositories.ts` or new `repositories/<name>-repo.ts`; (4) All queries through `applyTenantGuard()` or explicit `tenant_id + agent_id` predicates |
| Add a column | Migration first; then schema; then repo functions; then call sites |
| Add a complex query | Prefer a repo function over inline queries at call sites — keeps tenant scoping centralized |
| Override Drizzle defaults | Extend in `client.ts`; never per-call |

## Public surface

| Consumed by | What |
|---|---|
| All `src/*/` modules | Import schema types and repo functions |
| `src/governance/audit.ts` | Uses `auditRepo` + `runWithTenantContext` |
| `src/admin-ui/` | Reads schema directly (shared Drizzle types) |

The repositories are the only sanctioned interface. Raw `client.query()` is reserved for migrations and admin scripts.

## Tests

| Test path | What it covers |
|---|---|
| `tests/integration/leak.spec.ts` | Cross-tenant leak protection |
| `tests/integration/repos-leak.spec.ts` | Repository-level leak |
| `tests/unit/db/` | Schema + repo unit tests |
| `tests/integration/db/` | Live Postgres repo tests |
| `tests/integration/turn-context-batch-repos.spec.ts` | Batched reads: isolation on both JOIN sides, constant query cost |
| `tests/integration/turn-context-scope-cardinality.spec.ts` | `byIdsWithState` past 500 entities: entity side uncapped, state side capped |
| `tests/integration/turn-context-pool-fairness.spec.ts` | One caller's share of the shared pool, measured under real contention |

## In-flight changes

At last verification (2026-05-28):

- `'default'` literal rejection in tenant-context whitespace validation (#283 → #293 — open)
- DefaultResolver fixture-only + reject `'default'` in ALS (#282 → #296 — open)

Verify: `gh pr list --state open --search "tenant-context OR tenant-guard OR drizzle"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
