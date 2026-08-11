-- Issue #516 — ledger v2 for `schema_migrations`.
--
-- Why this migration exists at all, given that the runner bootstraps the same
-- DDL itself (src/migrations/ledger.ts `LEDGER_V2_DDL`):
--
--   The ledger has to exist BEFORE the first migration runs, so it cannot be
--   created *by* a migration — that is the chicken-and-egg the pre-#516 runner
--   already solved with `CREATE TABLE IF NOT EXISTS`. But a schema change that
--   only ever happens as a side effect of running a binary is invisible to
--   review and impossible to roll back. So the change ships BOTH ways: the
--   runner bootstraps it (so migration 001 has somewhere to be recorded), and
--   this file carries the identical, fully idempotent DDL so the change is
--   reviewable, reversible (`108_schema_migrations_v2_down.sql`) and applicable
--   with plain `psql -f`. Whichever runs first wins; the other is a no-op.
--   `tests/unit/migrations/ledger-schema-parity.spec.ts` keeps the two in sync.
--
-- Backward compatibility with the v1 runner (rollback safety): every added
-- column is nullable or defaulted and `applied_at` keeps `DEFAULT now()`, so
-- the old `INSERT INTO schema_migrations (id) VALUES ($1)` still works. Such a
-- row lands with a NULL checksum, which the v2 runner then reports as
-- `checksum_unknown` (blocking) until a backfill adopts the packaged checksum.
--
-- Scope: GLOBAL. Schema DDL is not tenant-scoped, so this table has no
-- tenant_id/agent_id columns — see docs/architecture/modules/migrations.md.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A `running` row has started but not finished, so it has no applied_at.
-- Dropping NOT NULL is what makes the in-flight state representable at all.
ALTER TABLE schema_migrations ALTER COLUMN applied_at DROP NOT NULL;

ALTER TABLE schema_migrations
  -- SHA-256 of the canonicalised migration file (src/migrations/checksum.ts).
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
  -- 'computed'  = hashed at apply time (verified).
  -- 'backfilled' = adopted from the packaged artifact after the fact (trusted).
  ADD COLUMN IF NOT EXISTS checksum_source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_ms INTEGER,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS runner_version TEXT,
  -- Error CLASS (SQLSTATE or constructor name) only. Never a driver message:
  -- pg error text embeds the connection string, password included.
  ADD COLUMN IF NOT EXISTS error_class TEXT,
  ADD COLUMN IF NOT EXISTS repaired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repair_reason TEXT;

DO $$
BEGIN
  ALTER TABLE schema_migrations
    ADD CONSTRAINT schema_migrations_status_check
    CHECK (status IN ('running', 'applied', 'dirty', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE schema_migrations
    ADD CONSTRAINT schema_migrations_checksum_source_check
    CHECK (checksum_source IS NULL OR checksum_source IN ('computed', 'backfilled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
