-- Rollback of 027_p4_operational_profile_immutable_content.sql
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DROP TRIGGER IF EXISTS agent_op_profile_content_immutable_trg
  ON agent_operational_profile_versions;
DROP FUNCTION IF EXISTS agent_op_profile_content_immutable();
