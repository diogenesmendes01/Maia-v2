-- P4: agent_operational_profile_versions — append-only, 4 camadas + status
-- proposed NUNCA entra em runtime. active vai pro prompt quando flag on.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_operational_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'active', 'frozen', 'rolled_back')
  ),
  core_immutable JSONB NOT NULL DEFAULT '{}'::jsonb,
  operational_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  episodic_temp JSONB NOT NULL DEFAULT '{}'::jsonb,
  growth_backlog JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_by TEXT NOT NULL,
  proposed_reason TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  frozen_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  rollback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, version)
);

CREATE INDEX agent_op_profile_tenant_agent_status_idx
  ON agent_operational_profile_versions(tenant_id, agent_id, status, version DESC);

CREATE UNIQUE INDEX agent_op_profile_unique_active_idx
  ON agent_operational_profile_versions(tenant_id, agent_id)
  WHERE status = 'active';
