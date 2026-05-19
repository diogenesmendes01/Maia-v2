-- Down migration for 053 (runtime_trace_bodies + runtime_trace_body_outbox)
DROP INDEX IF EXISTS runtime_trace_body_outbox_drain_idx;
DROP TABLE IF EXISTS runtime_trace_body_outbox;
DROP INDEX IF EXISTS runtime_trace_bodies_tenant_idx;
DROP TABLE IF EXISTS runtime_trace_bodies;
