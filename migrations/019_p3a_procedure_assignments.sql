-- P3a: procedure_assignments — vincula procedure_definitions a agents/roles com customizations
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id) ON DELETE CASCADE,
  definition_version INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'role')),
  target_id TEXT NOT NULL,
  customizations JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ,
  UNIQUE (tenant_id, definition_id, target_type, target_id)
);

CREATE INDEX procedure_assignments_target_idx
  ON procedure_assignments(tenant_id, target_type, target_id, enabled);
CREATE INDEX procedure_assignments_def_idx
  ON procedure_assignments(definition_id);
