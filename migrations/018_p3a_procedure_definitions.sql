-- P3a: procedure_definitions — objetos operacionais executáveis, versionados, imutáveis quando active
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'agent', 'role')),
  owner_agent_id TEXT REFERENCES agents(id),
  nome TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'proposed', 'active', 'frozen', 'rolled_back')
  ),
  intencao TEXT NOT NULL,
  when_apply JSONB NOT NULL DEFAULT '{}'::jsonb,
  when_not_apply JSONB NOT NULL DEFAULT '{}'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools_referenced JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('ensino', 'observacao', 'pratica', 'platform_wisdom')),
  proposed_by TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  source_candidate_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, nome, version_number)
);

CREATE INDEX procedure_def_tenant_agent_status_idx
  ON procedure_definitions(tenant_id, agent_id, status, nome);
CREATE INDEX procedure_def_active_idx
  ON procedure_definitions(tenant_id, agent_id, nome) WHERE status = 'active';
CREATE INDEX procedure_def_source_candidate_idx
  ON procedure_definitions(source_candidate_id) WHERE source_candidate_id IS NOT NULL;
