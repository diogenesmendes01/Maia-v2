-- P0: cria tenants e agents + seed da row 'default' pra preservar Maia atual
BEGIN;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agents_tenant_id_idx ON agents(tenant_id);

-- Seed 'default' tenant + 'default' agent (representa a Maia atual)
INSERT INTO tenants (id, nome, status) VALUES ('default', 'Default Tenant (Maia legacy)', 'active');
INSERT INTO agents (id, tenant_id, nome, status) VALUES ('default', 'default', 'Maia (legacy)', 'active');

COMMIT;
