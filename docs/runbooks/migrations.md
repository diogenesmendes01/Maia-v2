# Migrations runbook

How to author, apply, diagnose, repair and roll back SQL migrations.

Since issue #516 the runner is a shared library under
[`src/migrations/`](../../src/migrations/), driven by the `maia migrate` CLI
([`src/cli/maia.ts`](../../src/cli/maia.ts)). The same code runs from
`npm run db:migrate`, from the one-shot `migrate` service in both Compose
files, and from the testcontainer fixture — so the schema a test builds and the
schema production gets cannot drift.

## Commands

| Command | Writes? | What it is for |
|---|---|---|
| `npm run migrate:check` | no database at all | CI gate: every forward file has a `_down` sibling and a conforming prefix |
| `npm run migrate:manifest` | no database at all | this release's schema manifest (head, checksums, supported range) |
| `npm run migrate:plan` | **read-only** | what WOULD be applied, plus any drift |
| `npm run migrate:status` | **read-only** | the full ledger, migration by migration |
| `npm run migrate:up` (= `npm run db:migrate`) | applies | apply every pending migration |
| `npm run migrate:repair -- …` | **exceptional** | override one ledger row, with an actor and a reason |

Add `-- --json` to any of them for machine-readable output.

Exit codes are stable, because CI and the deploy job switch on them:

```
0  success / nothing to do
1  unexpected error (bug, unreachable database, invalid configuration)
2  refused: schema drift an operator has to resolve
3  another migrator holds the lock and did not release it in time
4  a migration failed (or left dirty state)
```

## How it applies

`plan`/`status` never take the lock and never issue DDL — they stay answerable
while a migration is in flight, which is exactly when you need them.

`up` does, in order:

1. take a **global advisory lock** on a dedicated connection —
   `pg_advisory_lock(0x4D414941 /* "MAIA" */, 1)`, held for the WHOLE run and
   released in `finally`. A second migrator waits up to
   `MIGRATION_LOCK_TIMEOUT_MS` and then exits cleanly with code 3. It never
   runs concurrently and never skips work believing it was already done;
2. create/upgrade the ledger idempotently (`ensureLedger`);
3. **reconcile orphan runs** — with the lock held, a `running` row can only be
   a crashed prior run (see "Dirty state" below);
4. **backfill checksums** for rows written by the pre-#516 runner, stamped
   `backfilled` so the provenance stays visible forever;
5. **evaluate drift** and refuse BEFORE any DDL if it finds a blocker;
6. apply pending migrations in order, stopping at the first failure.

## Ledger v2 (`schema_migrations`)

| Column | Meaning |
|---|---|
| `id` | the exact forward filename — the ledger key, never a number |
| `checksum_sha256` | sha256 of the **canonicalised** file (see below) |
| `checksum_source` | `runner` \| `backfilled` \| `repair` |
| `status` | `running` \| `applied` \| `dirty` \| `failed` |
| `started_at` / `applied_at` / `execution_ms` | timing |
| `app_version` / `runner_version` | which release and which runner |
| `error_class` | SQLSTATE or error name — **never** a driver message |

The migration SQL, driver messages and connection strings are never persisted
or logged. Failures carry a CLASS (`42P07`), which is enough to route you to
the right section here and not enough to leak a DSN.

`schema_migration_events` is the append-only trail of the exceptional facts
(lock waits, refusals, dirty state, checksum mismatches, backfills, repairs).
It is the primary evidence for a repair, because migrations run before
`audit_logs` exists on a fresh database.

**Backward compatible on purpose.** The pre-#516 runner did
`INSERT INTO schema_migrations (id) VALUES ($1)` and `SELECT id FROM
schema_migrations`; both still work. Only `applied_at`'s NOT NULL was dropped,
because a `running` row has not been applied and stamping it with `now()` would
make the ledger claim success.

### Checksums are over CANONICAL bytes

This repo ships no `.gitattributes` and Windows checkouts run with
`core.autocrlf=true`, so the same commit is CRLF on a laptop and LF in the
container. Hashing raw bytes would make every checksum platform-dependent and
the first `checksum_mismatch` would be a false positive — the fastest way to
teach an operator to ignore the real one.

The canonical form is: no BOM, LF line endings, no trailing whitespace,
exactly one terminating newline. A single changed character of SQL — or of a
comment — still changes the hash. **The whole file is the contract.**

## File layout and markers

```
migrations/
  110_schema_migrations_v2.sql        # forward (applied automatically)
  110_schema_migrations_v2_down.sql   # rollback (MANUAL, never automatic)
```

Forward files are applied in **lexical filename order** (a plain
`Array.prototype.sort()`, not a numeric parse). Do not "improve" this: the
ledger key is the filename, and a numeric sort would disagree with it on the
grandfathered shared prefixes (issue #308).

Markers, one per line, at the top of the file:

| Marker | Effect |
|---|---|
| `-- maia:no-transaction` | run outside `BEGIN/COMMIT` (for `CREATE/DROP INDEX CONCURRENTLY`). Each statement is sent separately — node-postgres wraps a multi-statement `query()` in an implicit transaction, which `CONCURRENTLY` rejects |
| `-- maia:idempotent` | the author asserts re-execution after a crash is safe (every statement `IF [NOT] EXISTS`, no row writes). This is the ONLY thing that lets a crashed no-tx migration be retried instead of going dirty |
| `-- maia:statement-timeout=30min` | per-migration override of `MIGRATION_STATEMENT_TIMEOUT_MS`. Versioned in the file so it is reviewed with the DDL it protects (`ms` / `s` / `min`) |

`-- maia:idempotent` on a file that is not actually idempotent is worse than no
marker at all: it turns "stop and inspect" into "silently re-run half-applied
DDL". Only add it when every statement is guarded.

### Duplicate migration numbers (and why you must NOT rename to "fix" them)

Several numbers are shared by more than one forward migration (007, 014, 015,
018, 020, 023, 025, 026, 027, 031, 062, 063 — issue #308). They all merged and
are applied in real environments. This is **benign**, because the runner tracks
migrations by filename, lexical sort is deterministic for ASCII filenames, and
the colliding files touch disjoint objects.

**Do NOT rename an already-merged migration.** Since #516 the runner detects it
for you: a rename makes the old ledger row report `missing_file` and the new
name report `pending`, and `up` refuses. Before #516 it silently re-ran the
file and orphaned the row.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MIGRATION_LOCK_TIMEOUT_MS` | `30000` | how long the second migrator waits before exiting with code 3 |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | `300000` | default per-statement budget |
| `MIGRATION_MIN_SUPPORTED` | expected head | oldest applied head this build tolerates — widen only for a deliberate expand/contract rollout |
| `MIGRATION_MAX_SUPPORTED` | unbounded | newest applied head this build tolerates — narrow it when a destructive migration makes the previous release unable to serve |
| `MIGRATION_ON_BOOT` | `false` | let the APP process migrate at boot. Single-instance escape hatch only |

Full descriptions: [`docs/configuration.md`](../configuration.md) (generated).

## Deploy

The supported path is the one-shot `migrate` service, in both Compose files:

```
postgres healthy
      ↓
migrate (same image, runs once, `restart: "no"`)
      ↓  service_completed_successfully
app + admin-ui
```

If `migrate` fails, the deploy stops there — `app` and `admin-ui` do not start.
That is the point: the schema is not what this build needs.

In production the `migrate` container has the **smallest secret surface in the
project**: no `env_file`, only the `migrator` subset from the per-service
manifest (Postgres + process knobs). It never receives `ANTHROPIC_API_KEY`,
`BAILEYS_AUTH_DIR`, `BACKUP_S3_SECRET_KEY` or `NEXTAUTH_SECRET`.

**Kubernetes / Coolify equivalent.** Use an init `Job` (or a release command)
running `node dist/cli/maia.js migrate up` from the same image, with the
application Deployment gated on its success. Where no job primitive exists at
all, `MIGRATION_ON_BOOT=true` is the escape hatch — still protected by the
advisory lock, so several replicas degrade into a queue rather than a
corruption. It is off by default because an application replica should not race
to migrate.

**Expand/contract.** A destructive migration must NOT ship in the same release
that removes the old code path. Ship expand (additive, both versions work),
deploy, then ship contract in a LATER release and narrow
`MIGRATION_MAX_SUPPORTED` there so the pre-contract version is blocked from
serving instead of failing at its first query.

## Readiness

`/readyz` includes a `schema` component that runs the SAME compatibility
evaluation ([`src/runtime/lifecycle/schema-version.ts`](../../src/runtime/lifecycle/schema-version.ts)).
It **never applies** anything. An instance stays out of rotation when:

| Code | Meaning |
|---|---|
| `pending` | a migration on disk is not applied (including a gap in the middle of the chain) |
| `checksum_mismatch` | an applied migration was edited |
| `missing_file` | an applied migration is absent from this build (renamed/deleted) |
| `dirty` | a no-tx migration left partial state |
| `failed` | a migration failed |
| `running_stale` | a migrator crashed mid-flight |
| `below_min` / `above_max` | the applied head is outside this build's supported range |

`missing_down_sibling` and `out_of_order` are reported but never drain a
healthy fleet: the first is a build-layout defect CI catches, the second is
what two branches merging out of authoring order legitimately looks like.

Metrics: `maia_schema_compatible`, `maia_schema_pending_count`,
`maia_schema_dirty_count`, `maia_schema_failed_count`,
`maia_schema_checksum_mismatch_count`.

## Recovery

### `up` exited 2 — "refused: schema drift"

Nothing was applied. Read the problems it printed, then:

**`checksum_mismatch`** — an already-applied migration was edited, which
violates the append-only rule (AGENTS.md §4.6). The fix is almost always to
**restore the file** to its merged content and put the change in a NEW
migration. Only if you have verified the edit was semantically empty (a comment,
whitespace) is `repair --resolution applied` appropriate, and it re-stamps the
checksum with `checksum_source='repair'` so the override stays visible.

**`missing_file`** — a merged migration was renamed or deleted. Restore it. If
the database was migrated by a NEWER release than this build, that is
`above_max` instead, and the answer is to deploy forward, not to touch files.

**`missing_down_sibling`** — write the `_down.sql`. `npm run migrate:check`
catches this with no database, so it should never reach a deploy.

### `up` exited 4 with DIRTY state

A `-- maia:no-transaction` migration failed part-way. Part of its DDL may have
landed and **no amount of re-running can tell you which part** — that is why
the runner stops instead of retrying, and why everything after it was not
attempted.

1. **Do not** re-run `up`. It will refuse, correctly.
2. `npm run migrate:status` — find the `dirty` row and its `error_class`.
3. Inspect the actual schema. For a `CREATE INDEX CONCURRENTLY`, an aborted run
   leaves an **INVALID** index:
   ```sql
   SELECT c.relname, i.indisvalid
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE NOT i.indisvalid;
   ```
   Drop invalid indexes (`DROP INDEX CONCURRENTLY <name>;`) before deciding.
4. Decide, and record the decision:
   ```bash
   # you verified the change is FULLY present:
   npm run migrate:repair -- --id 0NN_name.sql --resolution applied \
     --actor "you@example.com" --reason "índice idx_x validado como VALID em prod" --yes

   # you verified nothing landed (or you reverted it by hand):
   npm run migrate:repair -- --id 0NN_name.sql --resolution pending \
     --actor "you@example.com" --reason "índice ausente; reexecutando do zero" --yes
   ```
5. `npm run migrate:up` to continue the chain.

`repair` demands `--actor`, a `--reason` of at least 10 characters and `--yes`,
and writes all of it to `schema_migration_events`. **Never "clear the flag"
without inspecting the schema** — that is the exact failure this runner exists
to prevent.

### `up` exited 3 — lock timeout

Another migrator holds the lock. Nothing was applied and nothing is corrupt.
Wait for it, or raise `MIGRATION_LOCK_TIMEOUT_MS`. To see who:

```sql
SELECT pid, application_name, state, query_start
  FROM pg_stat_activity
 WHERE application_name = 'maia-migrator';
```

### `running_stale`

A migrator crashed. The next `up` reconciles it automatically under the lock:
transactional migrations (and no-tx ones declaring `-- maia:idempotent`) are
reset to pending; every other no-tx migration becomes `dirty` and follows the
procedure above.

## Reverting a migration (down) — manual, never automatic

Down migrations are **never** run by the runner, by a deploy, or by a rollback.
They are manual, destructive and require a backup first.

1. **Back up the database.**
   ```bash
   pg_dump "$DATABASE_URL" --no-owner --no-acl -F c -f /tmp/maia-pre-rollback.dump
   ```
2. Revert **one migration at a time**, most recent first. Never skip a step.
3. Apply the `_down.sql` with `psql`:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0NN_name_down.sql
   ```
   - `ON_ERROR_STOP=1` aborts on the first error.
   - Files NOT marked `maia:no-transaction` already wrap their work in
     `BEGIN/COMMIT`. Do not add another wrapper.
   - Files marked `-- maia:no-transaction` MUST run outside a transaction.
     `psql -f` honours that; do not use `psql -1`.
4. **Remove the ledger row** so the runner sees the migration as pending again:
   ```sql
   DELETE FROM schema_migrations WHERE id = '0NN_name.sql';
   ```
   Or `npm run migrate:repair -- --id 0NN_name.sql --resolution pending --actor … --reason … --yes`,
   which records WHY in the trail.
5. Verify with a smoke query before restarting the application.

### Rolling back the CODE (not the schema)

Reverting a deploy never runs a down migration. The ledger v2 stays readable by
the pre-#516 runner, so an old release can still apply migrations if it has to.
If the old release cannot serve on the newer schema, that is what
`MIGRATION_MAX_SUPPORTED` is for — set it in the newer release so the old one
is blocked at readiness instead of failing at its first query.

If you must go all the way back to a pre-v2 ledger, run
`110_schema_migrations_v2_down.sql` — but read its header first: it discards
every checksum and status, and a `dirty` row that loses its status becomes
indistinguishable from a successful one.

## Warnings

- **Down migrations are destructive.** Dropping a table or column permanently
  removes its data. The `_down.sql` files use `DROP ... IF EXISTS` for
  idempotency, but they cannot recover lost rows.
- **`DROP EXTENSION` lines** (in `001_initial_down.sql` and
  `002_specs_v1_down.sql`) only succeed if no other schema depends on those
  extensions. Comment them out if you share the database.
- **Reverting 002 widens `pessoas.status`.** It moves `'quarentena'` rows to
  `'inativa'` so the old CHECK can be re-applied.
- **Reverting 004 drops `pending_questions.metadata`.** That discards audit
  metadata stamped by the pre-LLM gate. Export it first if it matters.

## Adding a new migration

Write the forward file and its down file at the same time; they are reviewed
together.

1. **Reserve the prefix FIRST**: `npm run migrate:reserve "<short purpose>"`
   appends a line to [`migrations/RESERVATIONS.md`](../../migrations/RESERVATIONS.md).
   The reservation is the cheap thing you commit first; the SQL is the
   expensive thing you write after. Two branches picking the same prefix then
   collide as a git merge conflict instead of after the second PR merges.
2. Create `migrations/NNN_<short_name>.sql`.
3. Create `migrations/NNN_<short_name>_down.sql` that reverses it coherently:
   - header:
     ```sql
     -- Down migration for NNN_<short_name>.sql
     -- WARNING: destructive — review before applying. Run in transaction.
     ```
   - wrap in `BEGIN; … COMMIT;` unless it uses `CREATE/DROP INDEX
     CONCURRENTLY`, in which case prepend `-- maia:no-transaction` and omit the
     transaction block;
   - `DROP ... IF EXISTS` / `ALTER TABLE ... DROP COLUMN IF EXISTS`;
   - drop objects in reverse FK order (children before parents).
4. `npm run migrate:check` (no database needed), then test the pair locally:
   apply up, apply down, apply up again.
5. Open the PR with both files.

**Once merged, the file is frozen.** Editing it changes its checksum, and the
runner will refuse to apply anything on a database that recorded the old one.
Fix forward with a new migration.

## Known gap

`scripts/check-migration-reservations.ts` validates the ledger against the
files **on the current checkout**. It cannot see a concurrent branch that
reserved the same prefix — that collision surfaces as a merge conflict on
`RESERVATIONS.md` (by design) or, if the conflict is mis-resolved, at the
duplicate-prefix check on the second merge. The runner adds a runtime backstop:
a pending migration that sorts before the applied head is reported as
`out_of_order`. A pre-merge check against open PRs would close the gap
completely and is not implemented.
