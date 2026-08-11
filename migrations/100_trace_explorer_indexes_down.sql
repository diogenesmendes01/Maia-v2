-- 100 down — drop the Trace Explorer indexes (issue #514 §7).
--
-- Purely additive migration, so the rollback is a clean drop: no data, column
-- or constraint was introduced. The P10b indexes from migrations 052/053 are
-- untouched and keep serving the writer/worker paths after this runs.

DROP INDEX IF EXISTS runtime_trace_bodies_tenant_trace_idx;
DROP INDEX IF EXISTS runtime_trace_env_explorer_side_effect_idx;
DROP INDEX IF EXISTS runtime_trace_env_explorer_decision_idx;
DROP INDEX IF EXISTS runtime_trace_env_explorer_agent_idx;
DROP INDEX IF EXISTS runtime_trace_env_explorer_idx;
