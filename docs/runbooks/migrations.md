# Migrations runbook

This runbook explains how to apply and (manually) revert SQL migrations
in `migrations/`. The current setup uses a minimal viable layout: each
migration `NNN_<name>.sql` ships with a sibling `NNN_<name>_down.sql` for
rollback. Forward migrations are applied automatically; rollbacks are
manual for now (a `--down` flag in `scripts/migrate.ts` is a future
evolution).

## File layout

```
migrations/
  001_initial.sql                              # up
  001_initial_down.sql                         # down (manual)
  002_specs_v1.sql
  002_specs_v1_down.sql
  003_review_fixes.sql
  003_review_fixes_down.sql
  004_pending_one_active_per_conversa.sql
  004_pending_one_active_per_conversa_down.sql
  005_audit_mensagem_idx.sql
  005_audit_mensagem_idx_down.sql
```

`scripts/migrate.ts` discovers and applies every `NNN_*.sql` that does
not end in `_down.sql`, in **lexical filename order** (a plain
`Array.prototype.sort()` over the filename — not a numeric parse). Files
containing the marker `-- maia:no-transaction` on the first line (e.g.
005) are applied outside a `BEGIN/COMMIT` envelope so they can use
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`.

Note: this is **not** Drizzle. `drizzle-orm` is used only as a query
builder; the migration runner is the hand-rolled `scripts/migrate.ts`,
which records applied migrations by **full filename** in a
`schema_migrations (id TEXT PRIMARY KEY)` table.

### Duplicate migration numbers (and why you must NOT rename to "fix" them)

Several numbers are shared by more than one forward migration today
(007, 014, 015, 018, 020, 023, 025, 026, 027, 031, 062, 063 — see issue
#308). They all merged and are applied in real environments. This is
**benign** here, because:

- The runner tracks applied migrations by **filename**, not by number,
  so two files sharing a number are two independent ledger rows.
- Lexical sort is deterministic and locale-independent for ASCII
  filenames, so files sharing a number always apply in the same order on
  every platform, and the next number (`064_*`) always sorts after every
  `063_*` (third char `4` > `3`) — there is no ordering ambiguity.
- The colliding migrations to date touch disjoint objects, so their
  relative order is immaterial anyway.

**Do NOT rename an already-merged/applied migration to renumber it.**
Because the ledger key is the filename, a rename makes the runner treat
the file as un-applied (it re-runs) and orphans the old `schema_migrations`
row — corrupting the applied history for zero benefit. The accepted set
is grandfathered in
`tests/unit/scripts/migration-number-uniqueness.spec.ts`, which **fails
CI if a NEW duplicate number is introduced** (the actual fix: don't add
new collisions — see "Adding a new migration" below).

## Applying migrations (up)

```bash
npm run db:migrate
```

Applies every pending forward migration in order. Idempotent: each
migration is recorded in the migrations bookkeeping table and is not
re-run if already applied.

## Reverting a migration (down) — manual procedure

Down migrations are not yet wired into `scripts/migrate.ts`. To roll
back, apply the `_down.sql` file directly with `psql`. Always roll back
in reverse order — never skip an intermediate step.

1. **Back up the database first.** Down migrations are destructive: they
   drop tables, columns and indexes. For production, take a logical
   dump (`pg_dump`) before running anything.

   ```bash
   pg_dump "$DATABASE_URL" --no-owner --no-acl -F c -f /tmp/maia-pre-rollback.dump
   ```

2. **Identify the migration to revert.** Down only one migration at a
   time, starting from the most recent.

3. **Apply the corresponding `_down.sql`:**

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/005_audit_mensagem_idx_down.sql
   ```

   Notes:
   - `ON_ERROR_STOP=1` aborts on the first error.
   - Files NOT marked `maia:no-transaction` already wrap their work in
     `BEGIN/COMMIT`. Do not add extra transaction wrappers around them.
   - Files marked `-- maia:no-transaction` (e.g. 005) MUST run outside
     a transaction block. `psql -f` honors that automatically — do not
     wrap them with `psql -1` or a manual `BEGIN`.

4. **Manually mark the migration as un-applied** in whatever table
   `scripts/migrate.ts` uses for bookkeeping (check the script for the
   exact table name). Otherwise the runner will treat the migration as
   already applied and the next `npm run db:migrate` will skip it.

5. **Verify the rollback** with a smoke query (table missing, column
   gone, index dropped) before rerunning the application.

## Warnings

- **Down migrations are destructive.** Dropping a table or column
  permanently removes its data. The `_down.sql` files use
  `DROP ... IF EXISTS` for idempotency, but they cannot recover lost
  rows.
- **Always back up production** before running a down migration.
- **`DROP EXTENSION` lines** (in `001_initial_down.sql` and
  `002_specs_v1_down.sql`) only succeed if no other schema in the
  database depends on those extensions. Comment them out if you share
  the database with other apps.
- **Reverting 002 widens `pessoas.status`.** It moves rows in the
  `'quarentena'` state to `'inativa'` so the old CHECK constraint can
  be re-applied. If you have specific routing for quarantined people,
  capture them first.
- **Reverting 004 drops `pending_questions.metadata`.** This discards
  audit metadata stamped by the pre-LLM gate (cancel_reason, lost_race,
  etc.). Export it first if it matters.

## Adding a new migration

When you write a forward migration, write its down file at the same
time. The two are reviewed together.

1. Pick the next number: `NNN = max(existing) + 1`. It MUST be unused by
   any existing forward migration — the
   `migration-number-uniqueness.spec.ts` guard fails CI on a new
   duplicate. (Pre-merge-wave collisions are grandfathered there; do not
   add to them.) If you need to slot a migration between two already-used
   numbers, append a lowercase letter to sequence it (`038b`, `038c`) —
   that token is distinct and sorts after the bare number.
2. Create `migrations/NNN_<short_name>.sql` with the forward changes.
3. Create `migrations/NNN_<short_name>_down.sql` that reverses them
   coherently:
   - Header:
     ```sql
     -- Down migration for NNN_<short_name>.sql
     -- WARNING: destructive — review before applying. Run in transaction.
     ```
   - Wrap the body in `BEGIN; ... COMMIT;` unless it uses
     `CREATE/DROP INDEX CONCURRENTLY`, in which case prepend
     `-- maia:no-transaction` and omit the transaction block.
   - Use `DROP ... IF EXISTS` and `ALTER TABLE ... DROP COLUMN IF EXISTS`
     for idempotency.
   - Drop objects in reverse FK order (children before parents).
4. Test the pair locally: apply up, apply down, then apply up again.
5. Open a PR with both files. Reviewer checks that the down truly
   reverses the up.

## Future work

- Teach `scripts/migrate.ts` to discover `_down.sql` siblings and add a
  `--down=NNN` flag that applies the corresponding down file and
  removes the bookkeeping row.
- Optional: rename existing `NNN_<name>.sql` to `NNN_<name>_up.sql` for
  symmetry. Out of scope for the current minimal-viable change.
