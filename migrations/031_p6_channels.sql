-- P6: channels — instâncias de entrada de mensagem (1+ por agent)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  external_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('whatsapp', 'telegram', 'email', 'sms', 'web', 'api', 'other')),
  display_name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_type, external_id)
);

CREATE INDEX channels_tenant_agent_idx ON channels(tenant_id, agent_id);
CREATE INDEX channels_external_idx ON channels(channel_type, external_id);
