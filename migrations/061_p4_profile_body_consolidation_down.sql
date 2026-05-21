-- Reverse of 061: restore the four legacy JSONB columns from profile_body.
-- Only useful as a development/debug aid — production rollback should prefer
-- the regular rollback path and not run this down migration unless absolutely
-- necessary, since identity content under a v3.1.0 layout may no longer be
-- meaningful to the post-3.1.1 runtime.
DO $$
DECLARE
  has_profile_body boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'agent_operational_profile_versions'
       AND column_name = 'profile_body'
  ) INTO has_profile_body;

  IF NOT has_profile_body THEN
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';

  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             ADD COLUMN core_immutable      JSONB NOT NULL DEFAULT ''{}''::jsonb,
             ADD COLUMN operational_profile JSONB NOT NULL DEFAULT ''{}''::jsonb,
             ADD COLUMN episodic_temp       JSONB NOT NULL DEFAULT ''{}''::jsonb,
             ADD COLUMN growth_backlog      JSONB NOT NULL DEFAULT ''{}''::jsonb';

  EXECUTE 'UPDATE agent_operational_profile_versions
              SET core_immutable      = COALESCE(profile_body->''identity'', ''{}''::jsonb),
                  operational_profile = jsonb_build_object(
                    ''style'',    COALESCE(profile_body->''style'', ''{}''::jsonb),
                    ''metadata'', COALESCE(profile_body->''metadata'', ''{}''::jsonb)
                  )';

  EXECUTE 'ALTER TABLE agent_operational_profile_versions DROP COLUMN profile_body';
END;
$$;
