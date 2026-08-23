# migrations

**Path:** `src/migrations/` (SQL files live in [`migrations/`](../../../migrations/) at the repo root)

**Purpose** — Apply schema migrations exactly once per database, prove which ones were applied and with what content, represent partial failures instead of hiding them, and expose a read-only readiness verdict that `maia doctor` (#517) and `/readyz` can consume without re-deriving anything.

Introduced by issue #516. Replaces the loop that used to live inline in `scripts/migrate.ts`; that file is now a thin CLI over this module.

## Key files

| File | Role |
|---|---|
| `src/migrations/types.ts` | Vocabulary: ledger statuses, entry states, blockers, manifest, readiness. Pure data. |
| `src/migrations/checksum.ts` | Canonicalisation + SHA-256. The determinism contract. |
| `src/migrations/discover.ts` | Reads `migrations/`, orders it, detects markers, pairs `_down` siblings, tokenises SQL into top-level statements and **proves** the transaction envelope. Pure core (`buildMigrationArtifact`) + disk wrapper. |
| `src/migrations/status.ts` | **The decision core.** `computeMigrationStatus` (artifact + ledger ⇒ status) and `evaluateSchemaReadiness` (status + manifest ⇒ verdict). Pure, no DB. |
| `src/migrations/lock.ts` | Global advisory lock on a dedicated client, with waiting semantics. |
| `src/migrations/ledger.ts` | `schema_migrations` v2: bootstrap DDL, reads, state transitions, checksum backfill, repair. |
| `src/migrations/runner.ts` | `runMigrations` / `repairMigration` — the only things that change the schema. |
| `src/migrations/readiness.ts` | `getSchemaReadiness` / `getMigrationStatus` — read-only, never-throwing API. |
| `src/migrations/index.ts` | Public surface. |
| `scripts/migrate.ts` | CLI: `up` (default), `plan`, `status`, `repair`. Parses argv, prints, picks an exit code, and injects the contract's timeouts. Nothing else. |
| `src/config/migration-config.ts` | The migrator's config projection: `loadMigrationConfig()` + `migrationRunOptions()` (contract ⇒ `RunOptions`). Keeps `src/migrations/` free of `process.env`. |
| `src/observability/migration-collector.ts` | Scrape-time publication of the canonical verdict as Prometheus gauges. Reads, never writes. |
| `src/migrations/release-gate.ts` | **The gate outside Compose (#565).** Pure: filters an orchestrator's environment down to the `migrator` subset and decides the exit code. Touches no database. |
| `scripts/release-migrate.ts` | CLI (`npm run release:migrate`): spawns the migrator with the filtered environment and propagates its exit code. The thing you paste into a deploy panel. |

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

### `repair --as applied` refuses to certify what it cannot verify

`--as applied` means "I checked the schema; record this as done". Recording it means adopting the **packaged** checksum, exactly like the backfill — so when this build does not ship the file there is nothing to adopt. `repairEntry` writes `checksum_sha256 = COALESCE($2, checksum_sha256)`, so a NULL checksum used to leave the row's checksum NULL while still flipping `status` to `applied` and stamping `checksum_source = 'backfilled'`, and `repairMigration` still returned success. The next `status`/`up` blocked again on `missing_file` / `checksum_unknown` for that same id: the operator was told **"repaired"** while readiness had not moved.

So `repairMigration` (`src/migrations/runner.ts:545`) now requires a packaged migration **and** a checksum before it will honour `applied`. The check runs **before** the advisory lock and before `ensureLedgerSchema`, so a refusal costs no lock contention and writes no DDL; the ledger row is left byte-for-byte untouched and no `migration.repaired` event is emitted. `RepairResult.reason` carries the diagnosis, shaped like `ConfigValidationError` (`src/config/load.ts:59`) — what is missing, which state it would still be stuck in, and the two remediations:

- repair from a build that **does** ship the migration, so the packaged checksum can be adopted; or
- `--as pending`, which **deletes** the row instead of certifying it. `pending` stays available for exactly this case, because it needs nothing to verify.

`repairAppliedRefusal(id, rule)` is exported so the CLI, the tests and this doc quote one string. The CLI prints `repair refused: …` on stderr and exits **1**.

Adjacent and deliberately unchanged: a packaged file with a broken `_down` sibling still repairs, then blocks `up` on `artifact_integrity`. That describes the **repository**, not the ledger, and `repair` has no remediation for it in either direction.

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

Migrations are append-only (AGENTS.md §4 rule 6): the files merged before checksums existed could not be touched, renamed or re-hashed into history. So adoption is a **backfill, not a rewrite**:

1. `up` computes the checksum of every packaged file;
2. for each ledger row that is `applied` with a NULL checksum **and** has a file in the artifact, it writes that checksum with `checksum_source = 'backfilled'`;
3. from then on any divergence for that id is a hard blocker.

`backfilled` is the honest label: it means "we adopted whatever the artifact said at adoption time", i.e. trust, not verification. An edit made *before* the first backfill is invisible — the residual risk the issue itself names ("Backfill inicial de checksum confia no artefato usado nessa primeira execução"). It is bounded by doing the first backfill in staging and diffing before production.

Backfill is a **write**, so only `up` does it. `plan`, `status` and readiness report `checksum_unknown` instead: a read-only probe must not mutate the evidence it is reporting on.

**Determinism.** The digest is taken over a canonical form — BOM stripped, `\r\n`/`\r` normalised to `\n`, trailing whitespace at EOF removed — so the same file hashes identically on Windows, Linux and in the image, regardless of `core.autocrlf` or an editor's final-newline habit. Nothing else is normalised: interior whitespace, comments, casing and statement order are all content, because changing any of them changes what the migration does.

## The three transaction modes

Only one of them can make "schema changed" and "schema recorded" atomic, so the runner classifies instead of pretending:

| Mode | Trigger | Protocol | Crash leaves | Clean failure recorded as |
|---|---|---|---|---|
| `runner` | file has no transaction control (110 of 122 today) | `BEGIN` → SQL → ledger row → `COMMIT` | nothing — the migration is simply pending | `failed` (retried) |
| `self` | file has its own transaction control | commit `running` → SQL → flip to `applied` | a `running` row ⇒ dirty on the next pass | `failed` **only if the envelope is proven** (below), else `dirty` |
| `none` | `-- maia:no-transaction` (CONCURRENTLY DDL; also a phased constraint swap — below) | commit `running` → statements one at a time → flip to `applied` | a `running` row ⇒ dirty on the next pass | `dirty` |

The `self` mode fixes a latent defect in the pre-#516 runner. It wrapped every migration in `BEGIN`/`COMMIT` and wrote the ledger row inside that envelope, believing the pair was atomic. For a file that already contains `BEGIN; … COMMIT;` it was not: Postgres does not nest transactions, so the file's `COMMIT` ended the runner's transaction, the ledger `INSERT` ran in autocommit, and the runner's trailing `COMMIT` warned "no transaction in progress". A crash in that gap left the schema changed and the ledger silent, and the migration re-ran on the next boot.

### A `self` migration must be ONE complete envelope — and that is enforced

Detecting `BEGIN;` proves that the file manages its own transaction. It does **not** prove that the file is atomic, and `self` mode used to record a clean failure as `failed` — the *auto-retried* status — on exactly that unproven assumption.

The counter-example is one line long:

```sql
BEGIN;
CREATE TABLE t (id TEXT);
COMMIT;
ANALYZE t;          -- fails
```

By the time the last statement fails, `t` is **durably committed**. The runner's `ROLLBACK` in the catch block undoes nothing, and `failed` puts a half-applied schema straight back into the retry queue. The same hole exists for a file with two envelopes, a statement before the `BEGIN`, or a `BEGIN` that is never closed (which additionally hands a connection with an open transaction back to the pool, silently discarding both the DDL and the ledger row).

So the property is now **proven per file, at discovery**, by `analyzeTransactionEnvelope` (`src/migrations/discover.ts`):

1. `splitTopLevelStatements` tokenises the SQL, honouring line and block comments, string literals, quoted identifiers and dollar-quoted bodies — which is what keeps `CREATE FUNCTION … AS $$ … END; $$;` a single statement and stops PL/pgSQL's block `BEGIN`/`END` from being read as transaction control;
2. the file is `single_complete` only when the first top-level statement opens a transaction, the last one commits it, and there is nothing else outside;
3. anything else is `unverifiable` and becomes an **artifact problem** (`unverifiable_transaction_envelope`), which blocks `migrate up` before any DDL runs — the same fail-closed treatment a missing `_down` sibling gets;
4. as a second line of defence, `terminalLedgerStatusFor` (`src/migrations/runner.ts`) derives the terminal status from the proven envelope, so an unverifiable file that ever reached execution would be recorded `dirty`, never `failed`.

Both spellings of the choice offered by the review are therefore taken: validate the envelope **and** fail closed. Validation is what the operator sees (a named refusal, before the schema moves); the classification is what keeps the ledger honest if the refusal is ever bypassed.

Tokenising also made the mode classifier stricter in a second way: `BEGIN WORK;` and `START TRANSACTION ISOLATION LEVEL …` are now recognised as own transaction control. The previous line-anchored regex missed them, so such a file was filed as `runner` mode and got a *second, nested* `BEGIN` — the original defect, undetected. The classification of every packaged file is unchanged; `tests/unit/migrations/discover.spec.ts` pins that.

The five `self` migrations on disk today (007, 041, 050, 051, 108) all satisfy the envelope rule.

### `none` is not only for `CONCURRENTLY` — a phased constraint swap needs it too

`ADD CONSTRAINT … NOT VALID` + `VALIDATE CONSTRAINT` is the standard way to widen a CHECK on a hot table without holding `ACCESS EXCLUSIVE` for the full scan: the `ADD` is catalog-only and the `VALIDATE` takes just `SHARE UPDATE EXCLUSIVE`, which does not conflict with the `ROW EXCLUSIVE` a writer holds.

That only works **across commits**. In `runner` mode the whole file is one transaction, so the `ACCESS EXCLUSIVE` taken by the `DROP` (or by the `ADD` itself) is still held when `VALIDATE` runs, and the scan blocks writes exactly as if the pair were not there. A file that pairs `NOT VALID` + `VALIDATE` without `-- maia:no-transaction` promises a guarantee it does not deliver — which is worse than not claiming it, because someone reads that comment in a maintenance window.

`115_agent_turns_pending_race_lost.sql` is the worked example: three phases (new constraint under a temporary name `NOT VALID` → `VALIDATE` → short catalog-only swap), each its own commit. The price is the `none` protocol — the ledger row no longer commits with the DDL — so the file owes the reader an explicit crash matrix, and the runbook owes the operator a recovery table per intermediate state ([`docs/runbooks/migrations.md`](../../runbooks/migrations.md#dirty-on-115_agent_turns_pending_race_lostsql-troca-de-check-em-fases)). `tests/integration/migration-115-constraint-swap.spec.ts` pins the guarantee observably: a second client writes to `agent_turns` while the `VALIDATE` runs, under `lock_timeout`, and dies with `55P03` the moment the marker is removed.

`116_mensagens_tipo_evento.sql` is the second one, on `mensagens` — the inbound/outbound table, where holding `ACCESS EXCLUSIVE` for the scan blocks every message in and out. It shipped first as a bare `DROP` + `ADD` in `runner` mode and was rewritten to the same three phases; `tests/integration/migration-116-constraint-swap.spec.ts` pins it the same observable way.

**Down files are the opposite case.** They are applied by hand with `psql -v ON_ERROR_STOP=1 -f`, statement by statement, in a maintenance window — so a down that is *meant* to fail (because reverting would destroy evidence) must be one complete `BEGIN; … COMMIT;`, or its deliberate failure commits the `DROP` and leaves the table without the constraint it was protecting.

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
- **artifact integrity** — a forward migration with no `_down` sibling, a malformed prefix, a duplicate id, or a `self` migration whose SQL is not one complete transaction envelope. Blocks `up` (it must never reach a database) but not readiness: it describes the repository, not the compatibility of the schema already deployed.

## `status` is always the ledger as it stands NOW

`MigrationRunResult.status` is contracted as the complete description of artifact × database *at the moment the call returns*, and every consumer (`maia doctor` (#517), `/readyz`, the CLI) is allowed to act on it without re-querying. So it is recomputed from a fresh `readLedger` at every return that follows a ledger write — the success return **and** the failure return.

It used to be computed once before the apply loop and reused on the failure path. That made a failed run self-contradictory in two ways at once: `failure.ledger_status` said `dirty` while `status.entries` still classified the same id as `pending`, and every migration the run had just applied was still listed as pending. Automation reading `status` would then remediate a database that no longer existed.

If the re-read itself fails — a dead connection is a plausible cause of the failure being reported — `status` is `null`, the documented "could not be established" value, rather than a stale report presented as current.

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

### Prometheus series (issue #516 §Observabilidade)

`src/observability/migration-collector.ts`, wired at boot from `registerRuntimeObservability()`, publishes the canonical verdict as four gauge families read **at scrape time** from `checkSchemaReadiness()` — the same cached adapter `/readyz` consumes, so the metric and the gate cannot disagree:

| Series | Meaning |
|---|---|
| `maia_schema_migration_head{kind="expected"}` | 1-based position of this build's head in the ordered list of known migrations |
| `maia_schema_migration_head{kind="applied"}` | Same for the database's applied head; `0` = nothing applied |
| `maia_schema_migrations_pending` | Migrations still to apply (includes `failed`, which are retryable) |
| `maia_schema_migrations_dirty` | Migrations in `dirty` — `> 0` is pending human intervention |
| `maia_schema_migration_last_duration_ms` | `execution_ms` of the most recently applied migration, by clock |

Three decisions worth knowing before writing an alert:

- **Ordinal position, not the file number.** Twelve numbers are shared by more than one migration in this repo (issue #308), so `063` does not identify a head. The ordinal is computed over the same ordering the runner applies.
- **`NaN`, never `0`, on a failed read.** `0` pending and `0` dirty are the *healthy* reading, so a collector that returned 0 on failure would report "schema at head, nothing dirty" during a database outage. A failed refresh drops the snapshot rather than re-serving the last good one — same fail-closed posture as `backup-readiness-collector.ts`.
- **Global attribution, on purpose.** No `tenant_id`/`agent_id`: schema DDL is whole-database work that runs before per-tenant rows exist, and the advisory lock that serialises it is one for the entire database. Emission still goes through the sanctioned layer (`src/observability/metrics.ts::gauge`), which applies the label allowlist, the PII guard and the cardinality budget — that is the part issue #601 made non-negotiable.

**The lock wait is deliberately not a series.** `MigrationRunResult.lock_waited_ms` is known only inside the process that migrated, and that process is the one-shot `migrate` job, which exits and is never scraped. A gauge it published would sit frozen with no measurement at all — worse than absence, because it looks like a signal. It stays in the structured events above (`docker compose logs migrate`); the consequence of somebody holding the lock too long shows up as `maia_schema_migrations_pending` that does not fall.

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/migrations/checksum.spec.ts` | Cross-platform determinism + sensitivity; no collisions across the real forward files |
| `tests/unit/migrations/discover.spec.ts` | Ordering (matches the pre-#516 runner), markers, down siblings, the top-level tokeniser, every transaction-envelope verdict, and the real directory (every `self` file is one complete envelope; no packaged file changed mode) |
| `tests/unit/migrations/status.spec.ts` | Every entry state and every readiness blocker, including min/max range |
| `tests/unit/migrations/lock.spec.ts` | Acquire, wait, timeout, connect/query failure, idempotent release, namespace |
| `tests/unit/migrations/runner.spec.ts` | Order of operations, three transaction modes, dirty/failed transitions, the envelope guardrail and `terminalLedgerStatusFor`, `status` recomputed on the failure path, repair (including the `--as applied` refusal, its exact text, and that it precedes the lock), log hygiene |
| `tests/unit/migrations/readiness.spec.ts` | Read-only + never-throwing guarantees of the #517 surface |
| `tests/unit/runtime/lifecycle-schema-readiness.spec.ts` | The `/readyz` adapter: every blocking condition through the REAL decision core (injected pool + temp artifact), plus the cost contract (TTL cache, single-flight, negative caching) |
| `tests/integration/lifecycle-probes.spec.ts` | Each schema condition asserted as an HTTP 503 from the REAL `GET /readyz` route on `buildServer()` — a mirrored harness would pass even with the call site deleted |
| `tests/unit/migrations/ledger-schema-parity.spec.ts` | Migration 108 mirrors `LEDGER_V2_DDL`; the down truly reverses it |
| `tests/unit/migrations/compose-migrate-job.spec.ts` | The REAL `docker-compose.yml` / `compose.prod.yml`: the job exists, is gated on by `app`/`admin-ui` with `service_completed_successfully`, cannot restart itself out of "completed", shares the app's build, and (executably) its production environment satisfies `loadServiceConfig('migrator')` |
| `tests/integration/migration-115-constraint-swap.spec.ts` | Real Postgres, schema dedicado: os arquivos REAIS da 115 executados como `psql` os executa. O `_down` recusa **e** deixa a constraint de pé (`pg_get_constraintdef`), e a validação do `_up` não segura `ACCESS EXCLUSIVE` — aferido com escrita concorrente sob `lock_timeout` |
| `tests/unit/migrations/timeouts-from-contract.spec.ts` | The REAL CLI call site: `scripts/migrate.ts` hands `runMigrations` the timeouts projected from the contract (defaults = the previous constants), honours an operator override, maps `0` to "no ceiling", and refuses a negative value instead of ignoring it |
| `tests/unit/observability/migration-collector.spec.ts` | The gauge families, their fail-closed `NaN`, and — the anti-mirror-trap case — that they are wired from `registerRuntimeObservability()` rather than only from the spec |
| `tests/integration/migrations-runner-real-db.spec.ts` | Real Postgres: concurrent migrators, real dirty state, `status` recomputed on both failure paths, the durability of a committed envelope (the hazard behind the guardrail) and the refusal of the file that would hit it, v1→v2 backfill, CHECK constraints, the `--as applied` refusal against a real unpackaged row (+ the CLI's exit code). Skips without `TEST_DB_URL`. |

## How to extend

| Need | Where |
|---|---|
| Add a migration | Reserve the prefix in `migrations/RESERVATIONS.md`, then `NNN_<name>.sql` + `NNN_<name>_down.sql`. Never edit a merged file — the checksum will block. |
| A migration that wraps itself in `BEGIN; … COMMIT;` | Put **all** of its SQL inside that one envelope. Anything outside it (or a second envelope) is refused as `unverifiable_transaction_envelope`. Simplest alternative: drop the `BEGIN`/`COMMIT` entirely and let the runner own the transaction — then the ledger row commits atomically with the schema change. |
| A migration that needs a long statement timeout | `-- maia:statement-timeout=<ms>` in the file (versioned + reviewable), not a shell override |
| A migration that cannot run in a transaction | `-- maia:no-transaction`; keep it to simple `;`-terminated statements |
| Declare an expand/contract compatibility range | Pass a `manifest` to `getSchemaReadiness` |
| Consume schema health from a new surface | `getSchemaReadiness()` — never re-derive it by querying `schema_migrations` yourself |

## The `/readyz` gate

`src/runtime/lifecycle/readiness.ts` probes the `schema` component through
`src/runtime/lifecycle/schema-readiness.ts`, a thin cached adapter over
`getSchemaReadiness()`. It is the ONLY schema question `/readyz` asks.

| Situation | verdict | `/readyz` |
|---|---|---|
| every packaged migration applied, checksums match | `ready` | 200 |
| `dirty` row | `blocked` (`dirty_migration`) | **503** |
| ledger checksum ≠ packaged checksum | `blocked` (`checksum_mismatch`) | **503** |
| applied with no recorded checksum | `blocked` (`checksum_unknown`) | **503** |
| ledger cites a migration this build does not ship | `blocked` (`missing_file`) | **503** |
| expected head not applied | `blocked` (`schema_below_minimum`) | **503** |
| `running` row seen from a read-only caller | `blocked` (`running_migration`) | **503** |
| database unreachable, ledger absent, `migrations/` unreadable | `unknown` | **503** |

Fail-closed in both directions: `unknown` is a NOT-ready answer, never a
missing one. Artifact integrity problems (a missing `_down` sibling, a
malformed prefix) still block `migrate up` but deliberately do NOT block
readiness — they describe the repository, not the schema in the database.

**Cost.** `getSchemaReadiness()` re-reads and hashes the whole packaged
artifact and reads the whole ledger (~50-100 ms here). The verdict is cached
for `SCHEMA_READINESS_TTL_MS` (10 s) and concurrent polls are coalesced, so a
load-balancer poll costs ~one evaluation per 10 s per replica regardless of
rate. The TTL is the deliberate trade-off between a stale positive (serving up
to 10 s against a schema that just became incompatible — inside the window the
load balancer itself needs to declare a target unhealthy) and the cost of the
evaluation. The rationale lives in the module doc.

**`READINESS_SCHEMA_CHECK=false`** short-circuits the component to `ok`. It is
an ERROR in the `production` profile and refuses the boot (`src/config/rules.ts`,
rule `lifecycle/schema-check-disabled`, scope `boot`, so it holds even under
the `MAIA_CONFIG_STRICT_BOOT=false` rollback lever). Staging warns;
development is silent.

**Deploy order.** The migrator must run before the application: a v1 ledger
(rows without checksums) classifies as `checksum_unknown` and keeps `/readyz`
at 503 until `migrate up` adopts the packaged checksums. That order is now a
property of the deployment — see the next section.

## The Compose job (what actually advances the schema)

Everything above makes the schema *knowable*: it refuses traffic while the
database is behind. Nothing above *advances* it. Without a migrator in the
start-up path, `app` and `admin-ui` came up as soon as Postgres was healthy —
against an empty database — and stayed at 503 until an operator remembered to
run `exec app npm run db:migrate`. The readiness gate was doing its job and the
deployment was still broken.

Both `docker-compose.yml` and `compose.prod.yml` now carry a one-shot job:

```
postgres healthy → migrate (runs `npm run db:migrate`, exits 0) → app + admin-ui
```

| Property | Why it is what it is |
|---|---|
| same `build:` as `app` | the migrator applies exactly the migrations **this** build packages — the premise behind `checksum_mismatch` and `missing_file` |
| `restart: "no"`, explicit | every other service uses `unless-stopped`; inheriting it restarts the container after exit 0, so it never reaches "completed" and every dependant waits forever |
| `command: npm run db:migrate` | that is `up`, whose exit code is the contract: **0** success / already at head, **non-zero** failure, blocker or lock unavailable (`scripts/migrate.ts`) |
| `app` / `admin-ui` gate on `service_completed_successfully` | a blocker (dirty, checksum, missing file) fails the whole `up` instead of producing a permanently-503 instance |
| prod: **no** `env_file` | the migrator gets only the `migrator` subset of the config contract (#515) — Postgres + process knobs, never the LLM keys, WhatsApp session or S3 credentials |
| prod: `user 1001:1001`, `read_only`, `cap_drop: ALL`, `data` network only | the same hardened posture as every other production container; a job that only talks to Postgres has no business on the `web` network |
| prod: `tmpfs: /tmp` | not hygiene — `tsx` creates `/tmp/tsx-<uid>` before loading the first module, so a read-only rootfs without it kills the job at line one (measured by the smoke gate below) |
| dev: does **not** pin `NODE_ENV`/`MAIA_ENV` | `loadMigrationConfig()` rejects a contradiction between them (`profile/node-env-conflict`); pinning only `NODE_ENV=production` — what the `app` service does — would break every `.env` derived from `.env.example` |

The local flow is untouched: `npm run test:integration:setup` (which runs
`docker compose up -d --wait postgres redis` through `scripts/test-infra.ts`)
names its services explicitly, so it starts only those two and their
dependencies — never the job. Since issue #571 the Compose project name is
pinned in the file (`name: maia-v2`) so every `git worktree` drives the SAME
shared stack instead of asking for a private one with global container names;
the teardown, which destroys that shared stack, requires
`TEST_INFRA_TEARDOWN=yes`.

`tests/unit/migrations/compose-migrate-job.spec.ts` reads BOTH real files and
pins these properties, including an executable one: the environment
`compose.prod.yml` injects into the job is fed to `loadServiceConfig('migrator')`
and must validate. A missing `MAIA_ENV` there is not a subtle degradation — the
job exits non-zero on its first line and, through the dependency edge, holds the
whole stack down.

`MAIA_ENV` is interpolated as `${MAIA_ENV:?…}`, not `${MAIA_ENV:-production}`.
The default did not fail; it succeeded with the wrong answer. A **staging**
whose `.env.infra` omitted the line silently adopted the **production** profile,
and the first symptom was a production rule being applied — or relaxed — in an
environment nobody thought was production. With `:?`, `docker compose` aborts
before creating any container and names the missing variable. A staging rehearsal
with the same file is still one line (`MAIA_ENV=staging`) — now a written one.

## The smoke gate (the job actually running inside the image)

Everything above is a claim about *files*. `scripts/smoke-migrate-image.sh`
(`npm run smoke:migrate:image`, CI job `smoke-migrate-image`) is the claim about
the *image*: it builds the real `Dockerfile`, brings up an ephemeral Postgres,
and runs the real `npm run db:migrate` inside the image as uid 1001 with a
read-only rootfs — the conditions `compose.prod.yml` imposes on the job and the
one thing the Compose spec structurally cannot exercise.

It matters because `npm run db:migrate` is `tsx scripts/migrate.ts`, and `tsx`
resolves `@/*` at runtime from `tsconfig.json` rather than from the compiled
`dist/`. Two properties that read as hygiene are in fact requirements, both
measured by running the thing:

| Removed | The job dies with |
|---|---|
| `COPY tsconfig.json` (Dockerfile) | `ERR_MODULE_NOT_FOUND: Cannot find package '@/config' imported from /app/scripts/migrate.ts` |
| `tmpfs: - /tmp` (compose) | `ENOENT: no such file or directory, mkdir '/tmp/tsx-1001'` — `tsx` creates it before loading the first module |

The gate is written to fail loudly rather than pass cheaply: the database must be
provably empty first; a probe with the *same* flags asserts uid 1001 and that a
write to `/app/media` (which uid 1001 owns) is refused with `Read-only file
system`; the run must exit 0 **and** emit `migration.applied` events **and**
leave the ledger with exactly as many `applied` rows as the image packages. A
second run against the head must also exit 0 — that is the path every deploy
without a new migration takes. `npm_config_cache=/tmp/.npm` was measured *not*
to be load-bearing (`npm run` tolerates an unwritable cache) and is kept as
defence in depth for whenever the command grows.

There is no `--dockerfile` flag and no image fallback: the gate builds
`Dockerfile` or fails.

**What the job does NOT do.** It never runs a `_down.sql` (nothing in this
module can), it does not replace the backup that must precede a destructive
migration, and it is not a boot-time migrator inside the app: `app` still starts
`node dist/index.js` and only *validates* compatibility. Replicas never race —
and if two deploys overlap, the global advisory lock serialises them and the
second migrator exits cleanly.

## The gate outside Compose (issue #565)

`service_completed_successfully` is a Compose primitive. The three guarantees
the job buys are properties of the FILE — `restart: "no"`, the *absence* of
`env_file:`, and the `depends_on` edge — so a deploy that runs the same image
under a different orchestrator loses them silently, which is the failure mode
the job exists to eliminate.

`npm run release:migrate` (`scripts/release-migrate.ts` over
`src/migrations/release-gate.ts`) reproduces what a single command can
reproduce:

| Guarantee (#516) | How the gate reproduces it |
|---|---|
| runs the migrations **once**, exit 0 / non-zero | spawns the same `npm run db:migrate` and propagates the child's exit code unchanged; 0 leaves the gate by exactly one path |
| gets **only** the `migrator` subset (#515) | allowlist over the contract plus a closed list of process variables (`PATH`, `HOME`, `npm_config_cache`, …). `NODE_OPTIONS` and every `npm_config_*` other than the cache are withheld on purpose |
| consumers do not start until it succeeds | **only when chained** — `release:migrate && exec node dist/index.js`, where the `&&` is what enforces it. A panel's pre-deploy field can do the same, and whether a given panel does is NOT verified anywhere in this repo |

What is withheld is reported by name, never by value, in a
`release_gate.env_scrubbed` line. A withheld `MAIA_*`/`FEATURE_*` key the
contract does not declare gets its own list: the migrator would have refused
to boot on it (`contract/unknown`), so withholding it silently would turn a
loud configuration error into a green deploy.

Two things this does NOT recover, stated because the difference matters during
an incident: the surrounding container still HOLDS the secrets (only the
migrator *process* is denied them — a smaller blast radius, not the same one),
and `app`/`admin-ui` have no edge between them outside Compose, so ordering is
deploy discipline rather than a declared dependency.

Verified by execution: `tests/integration/release-migrate-gate.spec.ts` runs
the real command against a real Postgres in a disposable database — happy path
exit 0 with the full ledger, a dirty ledger exiting non-zero, the filtering
measured by a discriminator (the same variable makes the raw migrator exit 2
and never reaches it through the gate), and a chained consumer that does not
run when the gate fails. `tests/unit/migrations/release-gate.spec.ts` pins the
command against `compose.prod.yml` itself.

Not verified anywhere: that a deploy panel calls this command before the
rollout and abandons the rollout when it exits non-zero. That needs an
instance of the panel, and `docs/runbooks/deploy-prod.md` §7 says so where the
operator will read it.

## In-flight / not yet done (issue #516 DoD)

The owner reduced #516's scope formally on 2026-08-15: `maia doctor` moved to #517, and the Coolify/Kubernetes material to #565.

Delivered here: ledger v2, shared runner library, advisory lock, checksums + backfill, dirty state, repair, read-only status/plan, readiness API, the `/readyz` gate that consumes it, the one-shot Compose job that puts the schema at the head before `app`/`admin-ui` start (see the two sections above), the lock/statement timeouts as contract variables, and the Prometheus series.

Two things that used to be listed here are done and must not be redone:

- `maia doctor` consuming status + readiness — the `postgres.schema_readiness` check (`src/ops/doctor/checks/postgres.ts`) calls `getSchemaReadiness()` through the read-only seam in `src/ops/doctor/schema.ts`. The doctor never re-derives schema state;
- the timeouts — `MIGRATION_LOCK_WAIT_MS`, `MIGRATION_LOCK_POLL_MS`, `MIGRATION_LOCK_TIMEOUT_MS`, `MIGRATION_STATEMENT_TIMEOUT_MS`, declared on the `migrator` service only, with defaults identical to the constants they replace (30000 / 500 / 10000 / no ceiling). This module still never reads `process.env`: `scripts/migrate.ts` injects them via `migrationRunOptions()`.

Still open on #516:

- **a staging drill.** None of this has been exercised against a real staging database: bring up a replica behind the head, watch `/readyz` refuse, run the job, watch it rejoin rotation. Depends on the owner's environment, not on code;
- **the BOOT step still uses the weaker check — an OWNER decision, not an agent's.** `src/index.ts` (lifecycle step `schema`) calls `checkSchemaVersion()` (`src/runtime/lifecycle/schema-version.ts`), which compares the newest ledger id with the newest file on disk and nothing else. The canonical verdict (`src/migrations/status.ts`, exposed by `getSchemaReadiness()`) also sees checksum mismatch, `dirty`, orphaned `running`, a missing file and an incompatible head. Unifying them is a POLICY change with two defensible sides: keeping it means a schema condition costs one instance out of rotation with a self-describing 503 body, and that instance stays *inspectable*; unifying it means the same condition becomes a boot failure and, under a restarting supervisor, a **crash loop** — impossible to ignore, but the container you need to inspect is the one that will not stay up. The right answer depends on the supervisor, the alerting and whether anyone can reach the container. Recorded as the owner's decision on #516.
- **Coolify: entregue na #565** — `npm run release:migrate`, com a separação
  entre o que foi executado e o que não foi em
  `docs/runbooks/deploy-prod.md` §7 e na seção abaixo. **Kubernetes segue
  fora**: decisão do dono, entrega futura; não há manifesto nem init
  container neste repositório.

---

| | |
|---|---|
| Last verified | 2026-08-23 |
| Against `main` HEAD | `a932dedd` |
