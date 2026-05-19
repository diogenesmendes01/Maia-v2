-- Down migration for 052 (runtime_trace_envelopes)
DROP INDEX IF EXISTS runtime_trace_env_conversa_idx;
DROP INDEX IF EXISTS runtime_trace_env_body_pending_idx;
DROP INDEX IF EXISTS runtime_trace_env_tenant_created_idx;
DROP TABLE IF EXISTS runtime_trace_envelopes;
