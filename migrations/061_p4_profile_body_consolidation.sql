-- P4 (v3.1.1 alignment): consolidate the four legacy JSONB columns
-- (core_immutable, operational_profile, episodic_temp, growth_backlog) into
-- a single `profile_body` JSONB matching the schema.ts definition.
--
-- Why this migration exists separately from 025:
--   * Migration 025 was authored when the table had four layers per the
--     original P4 design.
--   * The v3.1.1-2026-05-15 refactor folded them into a single column, and
--     schema.ts + the operationalProfileVersionsRepo were updated, but the
--     SQL migration for the column change was never added — so any fresh
--     `npm run db:migrate` left the table with the old four-column layout
--     while ORM inserts targeted `profile_body`, throwing
--     `column "profile_body" of relation "agent_operational_profile_versions"
--      does not exist`. Surfaced while smoke-testing the admin-ui agent setup
--     flow (PR #162).
--
-- Strategy:
--   1. Add `profile_body` with the immutability-trigger temporarily disabled.
--   2. Backfill existing rows by composing the four legacy columns into the
--      shape ProfileBody expects.
--   3. Drop the four legacy columns.
--   4. Re-enable the trigger.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

-- 1) Detect whether the legacy columns are still present. If profile_body
--    already exists (e.g. someone manually applied this earlier), this
--    migration is a no-op.
DO $$
DECLARE
  has_legacy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'core_immutable'
  ) INTO has_legacy;

  IF NOT has_legacy THEN
    RETURN;
  END IF;

  -- 2) Add new column with default '{}'. Trigger fires on UPDATE only, so
  --    ALTER TABLE ADD COLUMN is fine.
  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             ADD COLUMN IF NOT EXISTS profile_body JSONB NOT NULL
                                       DEFAULT ''{}''::jsonb';

  -- 3) Disable the immutability trigger for the backfill UPDATE.
  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  -- 4) Backfill: compose ProfileBody from legacy columns. Existing rows
  --    that don't have a populated operational_profile.style/metadata
  --    block end up with empty `style` / `metadata` — the runtime will
  --    treat them as a v3.1.1 profile with the legacy identity preserved.
  EXECUTE 'UPDATE agent_operational_profile_versions
              SET profile_body = jsonb_build_object(
                ''schema_version'', ''v3.1.1-2026-05-15'',
                ''identity'',        COALESCE(core_immutable, ''{}''::jsonb),
                ''style'',           COALESCE(operational_profile->''style'', ''{}''::jsonb),
                ''metadata'',        COALESCE(operational_profile->''metadata'', ''{}''::jsonb)
              )
            WHERE profile_body = ''{}''::jsonb';

  -- 5) Drop the four legacy columns.
  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             DROP COLUMN core_immutable,
             DROP COLUMN operational_profile,
             DROP COLUMN episodic_temp,
             DROP COLUMN growth_backlog';

  -- 6) Re-create the immutability trigger now that the column shape matches
  --    the function (which references NEW.profile_body).
  EXECUTE 'CREATE TRIGGER agent_op_profile_content_immutable_trg
             BEFORE UPDATE ON agent_operational_profile_versions
             FOR EACH ROW
             EXECUTE FUNCTION agent_op_profile_content_immutable()';
END;
$$;
