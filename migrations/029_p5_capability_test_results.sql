-- P5: capability_test_results — auditoria de testes pós-ativação (loop fechado)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE capability_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  proposal_id UUID NOT NULL REFERENCES capability_proposals(id) ON DELETE CASCADE,
  gap_id UUID REFERENCES agent_capability_gaps(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'error')),
  scenarios_run JSONB NOT NULL DEFAULT '[]'::jsonb,
  scenarios_passed INTEGER NOT NULL DEFAULT 0,
  scenarios_failed INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_revert BOOLEAN NOT NULL DEFAULT false,
  technical_gap_id UUID REFERENCES agent_capability_gaps(id),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cap_test_results_proposal_idx
  ON capability_test_results(proposal_id, ran_at DESC);
CREATE INDEX cap_test_results_outcome_idx
  ON capability_test_results(tenant_id, agent_id, outcome, ran_at DESC);
