-- =====================================================================
-- Maia — Migration 081
-- calendar como capacidade base — backfill dos grants existentes + column default.
--
-- WHY: Tasks 1-2 (branch claude/calendar-default-pack) made
-- BASE_AGENT_PACKS = ['baseline.core', 'domain.calendar'] the floor for
-- NEW agents (seed) and grant-less fallbacks. However, EXISTING agents
-- already have an `agent_tool_grants` row persisted with
-- granted_packs = {baseline.core} — they won't see calendar without this
-- backfill.
--
-- WHAT THIS MIGRATION DOES
--   1. BACKFILL: adds 'domain.calendar' to every grant that does not yet
--      have it. Guarded by NOT ('domain.calendar' = ANY(granted_packs)) so
--      re-runs are safe and idempotent. Does NOT touch granted_tools or
--      denied_tools.
--   2. COLUMN DEFAULT: updates the column default for future INSERT paths
--      that go below the ORM layer (raw SQL seeds, future migrations, etc.)
--      to match the new floor.
--
-- IDEMPOTENT: the UPDATE WHERE clause makes re-runs a no-op for already-
-- updated rows. ALTER COLUMN SET DEFAULT is idempotent by definition.
--
-- denied_tools invariant (#5 — fail-closed): this migration NEVER touches
-- denied_tools. The backfill only appends to granted_packs, leaving any
-- HARD deny intact.
--
-- NOTE: no BEGIN/COMMIT — scripts/migrate.ts wraps each forward migration
-- in a transaction (no `-- maia:no-transaction` marker here).
-- Mirrors 076/077/078/079/080.
-- =====================================================================

-- Step 1: Backfill — add 'domain.calendar' to every existing grant that
-- doesn't already have it. Array_append is safe: it returns a new array
-- and does not create duplicates when the WHERE guard is correct.
-- Idempotent: the NOT ... = ANY(...) guard is a no-op on already-updated rows.
UPDATE agent_tool_grants
SET granted_packs = array_append(granted_packs, 'domain.calendar')
WHERE NOT ('domain.calendar' = ANY(granted_packs));

-- Step 2: Update the column default so raw-SQL INSERT paths (future
-- migrations, seeds, operator scripts) that do not specify granted_packs
-- also land on the new floor. Mirrors the in-code defaultAgentGrant()
-- helper and the Drizzle schema default in src/db/schema.ts.
ALTER TABLE agent_tool_grants
  ALTER COLUMN granted_packs SET DEFAULT '{baseline.core,domain.calendar}'::text[];
