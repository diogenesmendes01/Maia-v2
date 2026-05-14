-- Rollback contract (P6 down):
--   Destructive — drops the channels table and all rows. Run ONLY on a freshly
--   migrated environment that has not yet routed real traffic. Any FK rows
--   (channel_policies, role_selector_decisions) must be removed first via their
--   own down migrations (035 -> 034 -> 033 -> 032 -> 031). Running this on a
--   populated DB will either cascade-delete dependent data or error on the
--   FK — both are unrecoverable without a restore. No automatic data backup.
DROP INDEX IF EXISTS channels_external_idx;
DROP INDEX IF EXISTS channels_tenant_agent_idx;
DROP TABLE IF EXISTS channels;
