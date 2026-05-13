-- P6: roles — modos operacionais por agent (comercial, suporte, default, etc)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  prompt_addendum TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, role_key)
);

CREATE UNIQUE INDEX roles_unique_default_per_agent_idx
  ON roles(tenant_id, agent_id)
  WHERE is_default = true;

CREATE INDEX roles_tenant_agent_active_idx ON roles(tenant_id, agent_id, active);
