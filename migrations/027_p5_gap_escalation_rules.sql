-- P5: gap_escalation_rules — thresholds por (tenant, agent) para escalation determinística
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE gap_escalation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  dashboard_freq_threshold INTEGER NOT NULL DEFAULT 3,
  mentionable_severity_threshold INTEGER NOT NULL DEFAULT 5,
  proposed_combined_threshold INTEGER NOT NULL DEFAULT 8,
  proposed_min_distinct_contexts INTEGER NOT NULL DEFAULT 2,
  cooldown_days_proposed_to_proposed INTEGER NOT NULL DEFAULT 14,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id)
);
