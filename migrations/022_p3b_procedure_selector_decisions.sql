-- P3b: procedure_selector_decisions — log auditável de toda decisão do selector
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_selector_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  current_execution_id UUID REFERENCES procedure_executions(id) ON DELETE SET NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision TEXT NOT NULL CHECK (decision IN ('start', 'continue', 'switch', 'escalate', 'none')),
  selected_procedure_id UUID REFERENCES procedure_definitions(id),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('selector_llm', 'human_override', 'policy_default', 'rule')),
  reason TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_selector_conversa_idx
  ON procedure_selector_decisions(conversa_id, decided_at DESC);
