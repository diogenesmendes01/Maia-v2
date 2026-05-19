-- Down of 036: drop integral.
DROP INDEX IF EXISTS idx_policy_rules_one_active_uq;
DROP INDEX IF EXISTS idx_policy_rules_version_uq;
DROP INDEX IF EXISTS idx_policy_rules_descriptor_active;
DROP INDEX IF EXISTS idx_policy_rules_tenant_active;
DROP TABLE IF EXISTS policy_rules;
