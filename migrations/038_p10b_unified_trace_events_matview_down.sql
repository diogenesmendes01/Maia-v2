-- Down migration for 038
DROP INDEX IF EXISTS unified_trace_events_conversa_idx;
DROP INDEX IF EXISTS unified_trace_events_tenant_idx;
DROP INDEX IF EXISTS unified_trace_events_pk_idx;
DROP MATERIALIZED VIEW IF EXISTS unified_trace_events;
