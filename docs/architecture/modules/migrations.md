# migrations

**Path:** `src/migrations/` (SQL files live in [`migrations/`](../../../migrations/) at the repo root)

**Purpose** — Apply schema migrations exactly once per database, prove which ones were applied and with what content, represent partial failures instead of hiding them, and expose a read-only readiness verdict that `maia doctor` (#517) and `/readyz` can consume without re-deriving anything.

Introduced by issue #516. Replaces the loop that used to live inline in `scripts/migrate.ts`; that file is now a thin CLI over this module.

## Key files

| File | Role |
|---|---|
| `src/migrations/types.ts` | Vocabulary: ledger statuses, entry states, blockers, manifest, readiness. Pure data. |
| `src/migrations/checksum.ts` | Canonicalisation + SHA-256. The determinism contract. |
| `src/migrations/discover.ts` | Reads `migrations/`, orders it, detects markers, pairs `_down` siblings. Pure core (`buildMigrationArtifact`) + disk wrapper. |
| `src/migrations/status.ts` | **The decision core.** `computeMigrationStatus` (artifact + ledger ⇒ status) and `evaluateSchemaReadiness` (status + manifest ⇒ verdict). Pure, no DB. |
| `src/migrations/lock.ts` | Global advisory lock on a dedicated client, with waiting semantics. |
| `src/migrations/ledger.ts` | `schema_migrations` v2: bootstrap DDL, reads, state transitions, checksum backfill, repair. |
| `src/migrations/runner.ts` | `runMigrations` / `repairMigration` — the only things that change the schema. |
| `src/migrations/readiness.ts` | `getSchemaReadiness` / `getMigrationStatus` — read-only, never-throwing API. |
| `src/migrations/index.ts` | Public surface. |
| `scripts/migrate.ts` | CLI: `up` (default), `plan`, `status`, `repair`. Parses argv, prints, picks an exit code. Nothing else. |

## Scope: migrations are GLOBAL, not tenant-scoped

AGENTS.md §4 rule 1 requires every stateful boundary to scope by `tenant_id + agent_id`. Schema migrations are the documented exception and this is stated rather than silently skipped: DDL applies to the whole database, shared by every tenant and agent. So `schema_migrations` has no tenant/agent columns and the advisory lock is a single global key. A migration that changes tenant-scoped *data* still writes tenant-scoped rows inside its own SQL — only the bookkeeping is global.

## Commands

```bash
npm run db:migrate                  # = up
tsx scripts/migrate.ts plan         # read-only: what would be applied
tsx scripts/migrate.ts status       # read-only: full ledger vs artifact
tsx scripts/migrate.ts repair --id <file.sql> --as applied|pending --reason "..."
```

`plan` and `status` issue no DDL, take no lock and write nothing — safe against production. `up` and `repair` take the global lock. Down migrations are still manual (`docs/runbooks/migrations.md`); nothing in this module can execute a `_down.sql`.

## Ledger v2 (`schema_migrations`)

| Column | Meaning |
|---|---|
| `id` | Full forward filename. The key — never renamed (append-only). |
| `checksum_sha256` | SHA-256 of the canonicalised file. |
| `checksum_source` | `computed` (hashed at apply time — verified) or `backfilled` (adopted after the fact — trusted). |
| `status` | `running` · `applied` · `dirty` · `failed` |
| `started_at` / `applied_at` / `execution_ms` | Timings. `applied_at` is NULL while `running`. |
| `app_version` / `runner_version` | Provenance of the run that wrote the row. |
| `error_class` | SQLSTATE or constructor name. **Never** a driver message — pg error text embeds the DSN with its password. |
| `repaired_at` / `repair_reason` | Audit trail of an explicit repair. |

The DDL lives in **two** places on purpose: `LEDGER_V2_DDL` in `ledger.ts` (the ledger must exist before migration 001 can be recorded in it, so it cannot be created *by* a migration) and `migrations/108_schema_migrations_v2.sql` (so the change is reviewable and reversible like every other schema change). Both are idempotent; whichever runs first wins. `tests/unit/migrations/ledger-schema-parity.spec.ts` fails if they drift.

**The v1 runner can still read and write it.** Every added column is nullable or defaulted, and `applied_at` keeps `DEFAULT now()`, so the old `INSERT INTO schema_migrations (id) VALUES ($1)` still works. Such a row lands with a NULL checksum, which v2 then treats as `checksum_unknown` (blocking) until a backfill adopts the packaged checksum.

## Checksums, and how already-merged migrations were adopted

Migrations are append-only (AGENTS.md §4 rule 6): the 118 files merged before checksums existed could not be touched, renamed or re-hashed into history. So adoption is a **backfill, not a rewrite**:

1. `up` computes the checksum of every packaged file;
2. for each ledger row that is `applied` with a NULL checksum **and** has a file in the artifact, it writes that checksum with `checksum_source = 'backfilled'`;
3. from then on any divergence for that id is a hard blocker.

`backfilled` is the honest label: it means "we adopted whatever the artifact said at adoption time", i.e. trust, not verification. An edit made *before* the first backfill is invisible — the residual risk the issue itself names ("Backfill inicial de checksum confia no artefato usado nessa primeira execução"). It is bounded by doing the first backfill in staging and diffing before production.

Backfill is a **write**, so only `up` does it. `plan`, `status` and readiness report `checksum_unknown` instead: a read-only probe must not mutate the evidence it is reporting on.

**Determinism.** The digest is taken over a canonical form — BOM stripped, `\r\n`/`\r` normalised to `\n`, trailing whitespace at EOF removed — so the same file hashes identically on Windows, Linux and in the image, regardless of `core.autocrlf` or an editor's final-newline habit. Nothing else is normalised: interior whitespace, comments, casing and statement order are all content, because changing any of them changes what the migration does.

## The three transaction modes

Only one of them can make "schema changed" and "schema recorded" atomic, so the runner classifies instead of pretending:

| Mode | Trigger | Protocol | Crash leaves |
|---|---|---|---|
| `runner` | file has no transaction control (107 of 118 today) | `BEGIN` → SQL → ledger row → `COMMIT` | nothing — the migration is simply pending |
| `self` | file contains its own `BEGIN; … COMMIT;` | commit `running` → SQL → flip to `applied` | a `running` row ⇒ dirty on the next pass |
| `none` | `-- maia:no-transaction` (CONCURRENTLY DDL) | commit `running` → statements one at a time → flip to `applied` | a `running` row ⇒ dirty on the next pass |

The `self` mode fixes a latent defect in the pre-#516 runner. It wrapped every migration in `BEGIN`/`COMMIT` and wrote the ledger row inside that envelope, believing the pair was atomic. For a file that already contains `BEGIN; … COMMIT;` it was not: Postgres does not nest transactions, so the file's `COMMIT` ended the runner's transaction, the ledger `INSERT` ran in autocommit, and the runner's trailing `COMMIT` warned "no transaction in progress". A crash in that gap left the schema changed and the ledger silent, and the migration re-ran on the next boot.

## States and what blocks

| Entry state | Meaning | Blocks `up` | Blocks readiness |
|---|---|---|---|
| `applied` | in the artifact, ledger `applied`, checksum matches | — | — |
| `pending` | in the artifact, not in the ledger | — | yes, via the minimum-schema rule |
| `failed` | transactional migration that rolled back cleanly | — (retried) | yes, same rule |
| `dirty` | a `none`-mode run failed midway; schema may be partial | **yes** | **yes** |
| `running` | in flight *or* crashed — indistinguishable from a read-only probe | n/a | **yes** |
| `orphaned_running` | `running` observed while holding the lock ⇒ crash debris; promoted to `dirty` | **yes** | **yes** |
| `checksum_mismatch` | an applied migration was edited (or this build ships a different file) | **yes** | **yes** |
| `checksum_unknown` | applied with no recorded checksum | **yes** | **yes** |
| `missing_file` | the DB ran a migration this build does not ship | **yes** | **yes** |

Two things are **reported but not blocking**, deliberately:

- **out-of-order** — a pending migration that sorts before the applied head (a branch merged late). Reported in `status.out_of_order`; the runner still applies it in artifact order. Blocking it would break ordinary merge traffic, and the reservation ledger (`migrations/RESERVATIONS.md`) is the mechanism that prevents the dangerous version.
- **artifact integrity** — a forward migration with no `_down` sibling, or a malformed prefix. Blocks `up` (it must never reach a database) but not readiness: it describes the repository, not the compatibility of the schema already deployed.

## The readiness API (what #517 consumes)

```ts
import { getSchemaReadiness, getMigrationStatus } from '@/migrations/index.js';

const readiness = await getSchemaReadiness({ pool, migrationsDir });
//  { ready, state: 'ready'|'blocked'|'unknown', reason, blockers[],
//    manifest, expected_head, applied_head, pending_count, dirty_count,
//    checked_at, status }
```

Guarantees, all load-bearing for a consumer:

- **read-only** — no DDL, no ledger writes, no advisory lock, no backfill;
- **never throws** — a dead database, an absent ledger or a permission error all become `state: 'unknown', ready: false`;
- **fail-closed** — `ready === true` only after positive verification;
- **leak-safe** — blockers carry ids, states and short checksums; never SQL, driver text or `DATABASE_URL`;
- **self-contained** — `status` carries the full per-migration table, so a CLI renders a report without re-reading the database or re-hashing files.

### Compatibility manifest

```ts
{ schema_manifest_version: 1, expected_head, min_supported_migration, max_supported_migration }
```

The default (`defaultCompatibilityManifest`) is "I require my own head, and I do not cap how far ahead the database may be". Two overrides matter:

- **expand/contract rollout** — lower `min_supported_migration` to the earlier id the build tolerates, so a not-yet-migrated database still serves;
- **refuse a newer schema** — set `max_supported_migration` so an OLD build blocks against a database a NEWER release already migrated.

Destructive migrations must not ship in the same release that removes compatibility with the old schema — see the runbook.

## Advisory lock

`pg_try_advisory_lock(hashtextextended('maia_schema_migrations', 5160_5160))`, taken on a **dedicated** client (a session lock belongs to its connection) and released in `finally`. The namespace `5160_5160n` is fixed and distinct from `OPS_LOCK_NAMESPACE` (`5200_5200n`, `src/ops/backup/single-flight.ts`) and the outbound sweeper's (`4712_4712n`). It must never change between deploys: two releases with different namespaces would not exclude each other.

A second migrator **waits** (polling, so the wait is observable and the deadline exact) and then returns a typed non-acquisition. It never proceeds unguarded, and the library never calls `process.exit()`.

## Observability

Structured events, emitted through an injected sink (the CLI prints them as JSON lines): `migration.lock_wait`, `migration.lock_acquired`, `migration.lock_unavailable`, `migration.started`, `migration.applied`, `migration.failed`, `migration.dirty`, `migration.checksum_mismatch`, `migration.checksum_backfilled`, `migration.blocked`, `migration.repaired`.

Every payload is ids, short (12-char) checksums, durations, transaction mode and error **classes**. Never SQL, never driver messages, never connection strings — `tests/unit/migrations/runner.spec.ts` asserts this against an error message that deliberately contains a DSN with a password.

The ledger is the primary operational trail, because migrations can run before `audit_logs` exists (migration 001 is what creates the audited world).

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/migrations/checksum.spec.ts` | Cross-platform determinism + sensitivity; no collisions across the real 118 files |
| `tests/unit/migrations/discover.spec.ts` | Ordering (matches the pre-#516 runner), markers, down siblings, the real directory |
| `tests/unit/migrations/status.spec.ts` | Every entry state and every readiness blocker, including min/max range |
| `tests/unit/migrations/lock.spec.ts` | Acquire, wait, timeout, connect/query failure, idempotent release, namespace |
| `tests/unit/migrations/runner.spec.ts` | Order of operations, three transaction modes, dirty/failed transitions, repair, log hygiene |
| `tests/unit/migrations/readiness.spec.ts` | Read-only + never-throwing guarantees of the #517 surface |
| `tests/unit/migrations/ledger-schema-parity.spec.ts` | Migration 108 mirrors `LEDGER_V2_DDL`; the down truly reverses it |
| `tests/integration/migrations-runner-real-db.spec.ts` | Real Postgres: concurrent migrators, real dirty state, v1→v2 backfill, CHECK constraints. Skips without `TEST_DB_URL`. |

## How to extend

| Need | Where |
|---|---|
| Add a migration | Reserve the prefix in `migrations/RESERVATIONS.md`, then `NNN_<name>.sql` + `NNN_<name>_down.sql`. Never edit a merged file — the checksum will block. |
| A migration that needs a long statement timeout | `-- maia:statement-timeout=<ms>` in the file (versioned + reviewable), not a shell override |
| A migration that cannot run in a transaction | `-- maia:no-transaction`; keep it to simple `;`-terminated statements |
| Declare an expand/contract compatibility range | Pass a `manifest` to `getSchemaReadiness` |
| Consume schema health from a new surface | `getSchemaReadiness()` — never re-derive it by querying `schema_migrations` yourself |

## In-flight / not yet done (issue #516 DoD)

Delivered here: ledger v2, shared runner library, advisory lock, checksums + backfill, dirty state, repair, read-only status/plan, readiness API.

Not yet delivered, tracked on #516:

- **`/readyz` still uses the weaker #512 check.** `src/runtime/lifecycle/readiness.ts:102` probes the `schema` component via `checkSchemaVersion()` (`src/runtime/lifecycle/schema-version.ts`), gated by `config.READINESS_SCHEMA_CHECK`. That check compares the newest ledger id against the newest file on disk and nothing else: it cannot see a checksum mismatch, cannot see a dirty or orphaned `running` row, and deliberately reports `applied > expected` as `ok`. Swapping it for `getSchemaReadiness()` is the intended follow-up — the call site is one line, but `src/runtime/**` was outside this change's footprint;
- no one-shot `migrate` service in `docker-compose.yml` / `compose.prod.yml`, and the Dockerfile still starts the app directly;
- `maia doctor` (#517) is a separate issue and consumes this module;
- timeouts are call-site options with defaults, not configuration-contract variables (#515).

---

| | |
|---|---|
| Last verified | 2026-08-04 |
| Against `main` HEAD | `7b34e7e` |
