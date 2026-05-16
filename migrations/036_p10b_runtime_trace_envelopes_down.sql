-- Down migration for 036
DROP INDEX IF EXISTS runtime_trace_env_conversa_idx;
DROP INDEX IF EXISTS runtime_trace_env_body_pending_idx;
DROP INDEX IF EXISTS runtime_trace_env_tenant_created_idx;
DROP TABLE IF EXISTS runtime_trace_envelopes;
