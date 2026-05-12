-- P2: self-model — capabilities por domínio/skill + gaps
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_capabilities_domain (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  domain TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ,
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, domain)
);

CREATE TABLE agent_capabilities_skill (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  domain TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ,
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, domain, skill_name)
);

CREATE TABLE agent_capability_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  capability_description TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('tool', 'knowledge', 'procedure')),
  contexto TEXT,
  frequency_score INTEGER NOT NULL DEFAULT 1,
  severity_score INTEGER NOT NULL DEFAULT 1,
  current_level TEXT NOT NULL DEFAULT 'silent' CHECK (
    current_level IN ('silent', 'dashboard', 'mentionable', 'proposed')
  ),
  source_candidate_id UUID,
  last_observed TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_level_change_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX caps_domain_idx ON agent_capabilities_domain(tenant_id, agent_id, domain);
CREATE INDEX caps_skill_idx ON agent_capabilities_skill(tenant_id, agent_id, domain, skill_name);
CREATE INDEX caps_gaps_level_idx ON agent_capability_gaps(tenant_id, agent_id, current_level);
