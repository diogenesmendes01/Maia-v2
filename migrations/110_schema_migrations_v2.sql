-- 110_schema_migrations_v2.sql — issue #516
--
-- Ledger v2: the migration bookkeeping table stops being "a list of filenames
-- that ran at some point" and becomes an operational record — what was applied,
-- from which bytes, by which runner, how long it took, and whether it FINISHED.
--
-- Why this migration is written to be a no-op when the columns already exist:
-- the ledger has to exist before the migration that declares it can be recorded
-- in it. `ensureLedger()` (src/migrations/ledger.ts) creates exactly this shape
-- idempotently at the start of every run, so on a real deployment this file is
-- the reviewable, append-only STATEMENT of the shape, applied after the runner
-- already bootstrapped it. On a database migrated by an older runner it is the
-- thing that actually performs the upgrade.
--
-- BACKWARD COMPATIBILITY (issue #516 "Rollback"): the pre-#516 runner does
-- `INSERT INTO schema_migrations (id) VALUES ($1)` and `SELECT id FROM
-- schema_migrations`. Both keep working: every new column is nullable or
-- defaulted, and `applied_at` keeps its `DEFAULT now()`. Only its NOT NULL is
-- dropped, because a `running` row has not been applied yet and stamping it
-- with `now()` would make the ledger claim a migration succeeded when it is
-- still in flight.
--
-- No tenant/agent scope here on purpose: `schema_migrations` is global
-- infrastructure, not tenant state. It carries no tenant-owned rows, and the
-- runner never touches tenant data (AGENTS.md §4.1 applies to stateful tenant
-- boundaries — this is the schema itself).

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE schema_migrations
  -- sha256 of the CANONICALISED file (BOM stripped, CRLF→LF, single trailing
  -- newline). Canonical, not raw: Windows checkouts run with core.autocrlf and
  -- would otherwise hash the same commit differently from the Linux container.
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
  -- 'runner' | 'backfilled' | 'repair'. `backfilled` marks a checksum adopted
  -- once, from the artifact present at upgrade time, for a row that predates
  -- this migration. After the backfill, any divergence is a blocker.
  ADD COLUMN IF NOT EXISTS checksum_source TEXT,
  -- 'running' | 'applied' | 'dirty' | 'failed'. DEFAULT 'applied' is what makes
  -- the upgrade correct for existing rows: the old runner only ever inserted a
  -- row AFTER its SQL succeeded.
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'applied',
  ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_ms    INTEGER,
  -- Build identity (MAIA_BUILD_COMMIT) and runner identity. Answers "which
  -- release applied this?" during an incident without a git archaeology dig.
  ADD COLUMN IF NOT EXISTS app_version     TEXT,
  ADD COLUMN IF NOT EXISTS runner_version  TEXT,
  -- Error CLASS only (a SQLSTATE like 42P07, or an error name). Never a driver
  -- message: those carry the connection string.
  ADD COLUMN IF NOT EXISTS error_class     TEXT;

ALTER TABLE schema_migrations ALTER COLUMN applied_at DROP NOT NULL;

DO $migration_110$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schema_migrations_status_check'
  ) THEN
    ALTER TABLE schema_migrations
      ADD CONSTRAINT schema_migrations_status_check
      CHECK (status IN ('running','applied','dirty','failed'));
  END IF;
END
$migration_110$;

-- Partial index: the only rows anyone ever scans for are the unhealthy ones.
CREATE INDEX IF NOT EXISTS schema_migrations_unhealthy_idx
  ON schema_migrations (status) WHERE status <> 'applied';

COMMENT ON COLUMN schema_migrations.status IS
  'running | applied | dirty | failed. dirty = ran outside a transaction and did not complete; NEVER read as success.';
COMMENT ON COLUMN schema_migrations.checksum_sha256 IS
  'sha256 of the canonicalised migration file. Divergence on an applied row blocks migrate up AND readiness.';

COMMIT;
