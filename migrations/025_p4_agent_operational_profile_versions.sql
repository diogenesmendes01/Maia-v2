-- P4: agent_operational_profile_versions — append-only versionada
-- v3.1.1 (2026-05-15): consolidação em profile_body com 3 namespaces tipados
-- (identity, style, metadata). Demais Sources of Truth (Soul, Skills, Policy,
-- Memory) NÃO moram aqui — são consultadas independentemente pelo Context
-- Assembly via slice builders.
--
-- Status: proposed NUNCA entra em runtime. active vai pro prompt quando flag on.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_operational_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'active', 'frozen', 'rolled_back')
  ),
  profile_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Shape (schema_version='v3.1.1-2026-05-15'):
  -- {
  --   "schema_version": "v3.1.1-2026-05-15",
  --   "identity": {
  --     "role_descriptor": "...",
  --     "voice": { "tone", "formality", "verbosity" },
  --     "cognitive_limits": { "max_inference_depth", "max_speculation_in_response", "confidence_floor_for_action" },
  --     "priorities": [...],
  --     "learned_voice_modifiers": []
  --   },
  --   "style": { "language": "pt-BR", "rhythm": {} },
  --   "metadata": { "effective_from", "created_by", "previous_version_id" }
  -- }
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
