-- 041: debug_snapshot_grants — TTL-bounded access to runtime_trace_bodies
-- (P8.5 Admin UI v1)
--
-- A debug snapshot grant is a TTL-bounded permission for a specific user
-- to view the full (un-redacted) body of a runtime trace. Cron job (P11)
-- will revoke expired grants and notify granters.

CREATE TABLE IF NOT EXISTS debug_snapshot_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  granted_to_user_id TEXT NOT NULL REFERENCES app_users(id),
  granted_by_user_id TEXT NOT NULL REFERENCES app_users(id),
  trace_id UUID NOT NULL,
  reason TEXT NOT NULL,
  category TEXT,
  read_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS debug_snapshot_grants_expires_idx ON debug_snapshot_grants(expires_at);
CREATE INDEX IF NOT EXISTS debug_snapshot_grants_tenant_id_idx ON debug_snapshot_grants(tenant_id);
CREATE INDEX IF NOT EXISTS debug_snapshot_grants_granted_to_idx ON debug_snapshot_grants(granted_to_user_id);
CREATE INDEX IF NOT EXISTS debug_snapshot_grants_trace_idx ON debug_snapshot_grants(trace_id);
