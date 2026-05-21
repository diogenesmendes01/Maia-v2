-- Reverse of 061 (additive variant): drop the `profile_body` column.
-- Legacy columns were never touched so there's nothing to restore on the
-- legacy side.
DO $$
BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
             ON agent_operational_profile_versions';
  EXECUTE 'ALTER TABLE agent_operational_profile_versions
             DROP COLUMN IF EXISTS profile_body';
  -- Re-create the trigger only if the legacy column still exists (so the
  -- function body has a column to compare against). On a "schema after 061"
  -- DB this would no longer fire correctly anyway, since the function refs
  -- profile_body — but down-migration is a debug aid, not a production path.
END;
$$;
