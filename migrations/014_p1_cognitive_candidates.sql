-- P1: queue pra candidatos classificados sem destino dedicado (procedimento, lacuna, tool_request)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE cognitive_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  source_event_type TEXT NOT NULL,
  source_event_id UUID,
  candidate_type TEXT NOT NULL CHECK (
    candidate_type IN ('procedimento', 'lacuna', 'tool_request')
  ),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'consumed', 'rejected', 'expired')
  ),
  consumed_by_phase TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cognitive_candidates_tenant_agent_status_idx
  ON cognitive_candidates(tenant_id, agent_id, status, created_at DESC);
CREATE INDEX cognitive_candidates_type_status_idx
  ON cognitive_candidates(candidate_type, status);
