-- Down migration for 037
DROP INDEX IF EXISTS runtime_trace_bodies_tenant_idx;
DROP TABLE IF EXISTS runtime_trace_bodies;
