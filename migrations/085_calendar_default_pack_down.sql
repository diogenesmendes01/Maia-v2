-- Down migration for 085_calendar_default_pack.sql
--
-- Reverses the forward migration:
--
-- 1. Removes 'domain.calendar' from granted_packs for every row that has
--    it. Safe because nothing granted 'domain.calendar' before this feature
--    (migration 076 seeded all grants with {baseline.core} only), so no
--    pre-existing explicit grant is incorrectly removed.
--    Idempotent: the WHERE 'domain.calendar' = ANY(granted_packs) guard is a
--    no-op on rows that do not contain it.
--
-- 2. Restores the column default to '{baseline.core}' (pre-migration state).
--
-- NOTE: The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. Always back up first.

-- Step 1 reversal: remove 'domain.calendar' from every row that has it.
-- array_remove is safe and idempotent: returns the array unchanged if the
-- element is not present.
UPDATE agent_tool_grants
SET granted_packs = array_remove(granted_packs, 'domain.calendar')
WHERE 'domain.calendar' = ANY(granted_packs);

-- Step 2 reversal: restore the column default to the pre-085 value
-- ({baseline.core} only, as set by migration 076; migration 083 drops only the
-- literal 'default' tenant_id/agent_id column-defaults, never granted_packs).
ALTER TABLE agent_tool_grants
  ALTER COLUMN granted_packs SET DEFAULT '{baseline.core}'::text[];
