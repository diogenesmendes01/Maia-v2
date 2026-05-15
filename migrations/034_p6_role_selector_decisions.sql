-- P6: role_selector_decisions — log append-only de TODA decisão do role selector
-- (mesmo "manter atual"). decided_by NUNCA pode ser llm_classifier.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE role_selector_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  channel_id UUID REFERENCES channels(id),
  policy_id UUID REFERENCES channel_policies(id),
  current_role_id UUID REFERENCES roles(id),
  suggested_role_id UUID REFERENCES roles(id),
  decided_role_id UUID NOT NULL REFERENCES roles(id),
  action TEXT NOT NULL CHECK (action IN ('keep_current', 'switch', 'handoff', 'fallback')),
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_by TEXT NOT NULL CHECK (suggested_by IN ('llm_classifier', 'deterministic_classifier', 'none')),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('policy_default', 'policy_rule', 'owner_override', 'fallback_rule')),
  suggested_strength TEXT CHECK (suggested_strength IS NULL OR suggested_strength IN ('weak', 'medium', 'strong')),
  suggested_confidence NUMERIC(4, 3),
  reason TEXT,
  switch_count_in_conversation INTEGER NOT NULL DEFAULT 0,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX role_selector_conversa_idx
  ON role_selector_decisions(conversa_id, decided_at DESC);
CREATE INDEX role_selector_tenant_agent_idx
  ON role_selector_decisions(tenant_id, agent_id, decided_at DESC);
