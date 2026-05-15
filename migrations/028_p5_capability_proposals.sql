-- P5: capability_proposals — propostas formais (spec gerada por LLM no nível 'proposed')
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE capability_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  gap_id UUID REFERENCES agent_capability_gaps(id),
  capability_type TEXT NOT NULL CHECK (
    capability_type IN ('tool', 'knowledge', 'procedure', 'integration', 'other')
  ),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposed_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  motivation TEXT NOT NULL,
  expected_impact TEXT,
  test_scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'delivered')
  ),
  submitted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  decision_reason TEXT,
  delivered_at TIMESTAMPTZ,
  delivery_artifact_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cap_proposals_tenant_agent_status_idx
  ON capability_proposals(tenant_id, agent_id, status, created_at DESC);
CREATE INDEX cap_proposals_gap_idx
  ON capability_proposals(gap_id);
