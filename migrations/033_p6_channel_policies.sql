-- P6: channel_policies — governa como roles operam no channel + travas anti-oscilação
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE channel_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  default_role_id UUID NOT NULL REFERENCES roles(id),
  switch_behavior TEXT NOT NULL CHECK (
    switch_behavior IN ('locked', 'prefer_handoff', 'free_with_trigger', 'by_context')
  ),
  announce_mode TEXT NOT NULL DEFAULT 'affects_user' CHECK (
    announce_mode IN ('always', 'never', 'affects_user')
  ),
  by_context_guards JSONB NOT NULL DEFAULT '{
    "min_confidence_to_switch": 0.7,
    "cooldown_turns": 3,
    "required_strength_delta": 0.2,
    "max_switches_per_conversation": 3
  }'::jsonb,
  allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id)
);

CREATE INDEX channel_policies_tenant_agent_idx ON channel_policies(tenant_id, agent_id);
