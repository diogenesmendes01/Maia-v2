-- Rollback contract (P6 down):
--   Destructive — drops the roles table and all rows. Run order: 035 -> 034
--   -> 033 -> 032 (this) -> 031. Any FK rows in channel_policies.default_role_id
--   or role_selector_decisions.{decided_role_id,suggested_role_id} must be
--   removed first. Running on a populated DB will either cascade-delete
--   dependent data or error on the FK — both are unrecoverable without restore.
DROP INDEX IF EXISTS roles_tenant_agent_active_idx;
DROP INDEX IF EXISTS roles_unique_default_per_agent_idx;
DROP TABLE IF EXISTS roles;
