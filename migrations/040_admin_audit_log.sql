-- 040: admin_audit_log — append-only audit trail for admin-ui mutations
-- (P8.5 Admin UI v1)
--
-- This is APPEND-ONLY: no UPDATE or DELETE statements should ever target this table.
-- The constraint is enforced at the application layer (writeAuditLog repo function)
-- and verified by linting. In production, a DB role grant restriction is recommended.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  change_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_tenant_id_created_idx
  ON admin_audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_id_idx
  ON admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS admin_audit_log_resource_idx
  ON admin_audit_log(resource_type, resource_id);
