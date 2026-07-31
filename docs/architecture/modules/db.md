# db

**Path:** `src/db/`

**Purpose** — Drizzle ORM schema, repositories, query helpers, and the tenant-isolation primitives (`tenant-context.ts`, `tenant-guard.ts`). The schema defines every table; repositories provide the typed query interface; the tenant-context + guard pair enforces `tenant_id + agent_id` scoping on every query. SQL migrations live in `migrations/` at the repo root, not under `src/db/`.

## Key files

| File | Role |
|---|---|
| `src/db/schema.ts` | Drizzle schema for all tables |
| `src/db/repositories.ts` | Aggregated repository functions (transactions, audit, conversations, etc.) |
| `src/db/repositories/turn-repos.ts` | `agentTurnsRepo` — única porta de escrita da máquina de estados do turno inbound (issue #503, migrations 096/097). Toda transição é compare-and-swap sobre `state_version`; transição terminal escreve, na MESMA transação, a projeção de compatibilidade `mensagens.processada_em`. Vocabulário e tabela de transições em [`src/runtime/turns/contract.ts`](runtime.md). |
| `src/db/repositories/holidays-repo.ts` | Holiday repository |
| `src/db/repositories/holiday-entidades-repo.ts` | Per-entity holiday repository |
| `src/db/client.ts` | Postgres connection pool + Drizzle init |
| `src/db/tenant-context.ts` | `runWithTenantContext`, `tryGetCurrentContext`, `getCurrentContext`, `MissingTenantContextError` |
| `src/db/tenant-guard.ts` | `applyTenantGuard()` — query-builder helper that injects scoping predicates |
| `src/db/capability-risk.ts` | Capability risk scoring helper |

## Migration runner (issue #516)

The runner is **not** in `src/db/`. It lives in [`src/migrations/`](../../../src/migrations/) and is deliberately independent of `@/config/env.ts` and `@/db/client.ts`, so a migration container is configured from the `migrator` service subset (Postgres only) instead of the whole runtime configuration.

| File | Role |
|---|---|
| `src/migrations/discover.ts` | forward-file discovery, markers, canonical checksums |
| `src/migrations/compatibility.ts` | PURE artifact-vs-ledger evaluation — the contract `/readyz`, `maia migrate status` and `maia doctor` (#517) all read |
| `src/migrations/ledger.ts` | ledger v2 (`schema_migrations`) + `schema_migration_events` |
| `src/migrations/lock.ts` | global advisory lock, namespace `(0x4D414941 "MAIA", 1)` |
| `src/migrations/runner.ts` | `planMigrations` / `migrateUp` / `repairMigration` |
| `src/cli/maia.ts` | `maia migrate check\|manifest\|plan\|status\|up\|repair` |

`src/runtime/lifecycle/schema-version.ts` consumes `evaluateCompatibility` for the `/readyz` schema gate; it validates and NEVER applies. Runbook: [`docs/runbooks/migrations.md`](../../runbooks/migrations.md).

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — `runWithTenantContext` + `applyTenantGuard` are the canonical scoping mechanism
- Migrations are append-only: new `<n>_<name>.sql` files in `migrations/`; never edit a merged file. Since #516 the runner ENFORCES this — an edited merged migration fails `migrate up` and `/readyz` with `checksum_mismatch`
- `schema_migrations` and `schema_migration_events` carry no tenant-scoped rows: they are global infrastructure, not tenant state

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
| `tests/unit/migrations/` | Discovery, checksum determinism, compatibility, CLI (no database) |
| `tests/integration/migration-runner-real-db.spec.ts` | Advisory lock, dirty state, transactional atomicity, v1→v2 ledger, repair — the only evidence for those, since they are server semantics |

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
