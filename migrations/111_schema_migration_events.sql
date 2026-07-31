-- 111_schema_migration_events.sql — issue #516
--
-- Append-only operational trail for the migration runner.
--
-- WHY NOT `audit_logs`: migrations run BEFORE the audit tables exist on a fresh
-- database, and a runner whose success depended on the audit table could not
-- create it. The issue is explicit about this — "o ledger é a trilha
-- operacional primária, pois migrations podem ocorrer antes da criação das
-- tabelas de auditoria". A summarised `audit()` event may still be emitted by
-- the application later; the runner never depends on it.
--
-- WHAT LANDS HERE: only the EXCEPTIONAL facts — lock waits, refusals, dirty
-- state, checksum mismatches, checksum backfills, orphan-run resets and
-- repairs. Routine success already lives in `schema_migrations` itself, and
-- duplicating it here would bury the incidents.
--
-- The `repair` event is the reason this table is not optional: `maia migrate
-- repair` is the one command that can declare a partially-applied migration
-- "done" on an operator's word. That word has to be written down, with who
-- said it and why, somewhere the same rollback cannot erase.
--
-- No tenant/agent scope: like `schema_migrations`, this is global
-- infrastructure and carries no tenant-owned rows.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migration_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Free text on purpose (not an enum): a new runner event must never need a
  -- migration to be recordable, and an unknown event is still better evidence
  -- than a swallowed one. The vocabulary lives in src/migrations/ledger.ts.
  event        TEXT NOT NULL,
  migration_id TEXT,
  -- Who asserted this. Only ever set for operator-driven events (`repair`).
  actor        TEXT,
  reason       TEXT,
  -- Structured context. NEVER the migration SQL, never a driver message,
  -- never a connection string — the writer redacts by construction.
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS schema_migration_events_occurred_idx
  ON schema_migration_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS schema_migration_events_migration_idx
  ON schema_migration_events (migration_id, occurred_at DESC)
  WHERE migration_id IS NOT NULL;

COMMENT ON TABLE schema_migration_events IS
  'Append-only trail of exceptional migration-runner facts (issue #516). Primary operational evidence for repairs — audit_logs may not exist yet when migrations run.';

COMMIT;
