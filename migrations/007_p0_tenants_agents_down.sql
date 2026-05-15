-- Rollback for 007_p0_tenants_agents.sql
-- WARNING: drops tenants + agents and all their data. CASCADE is intentional
-- so dependents from later migrations (cognitive_module_log, FK columns added
-- in 010+) come along too. Operator must confirm no production data is at
-- risk before running this manually via `psql -f`.

BEGIN;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
COMMIT;
