-- P2: memory_entry table com 6 controles + needs_review
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE memory_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  interlocutor_id UUID,
  conversa_id UUID,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('operational', 'preference', 'personal', 'sensitive', 'unknown')
  ),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('conversation', 'interlocutor', 'channel', 'role', 'agent', 'tenant')
  ),
  subject_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'low' CHECK (
    sensitivity IN ('low', 'medium', 'high')
  ),
  proactive_use BOOLEAN NOT NULL DEFAULT false,
  mention_allowed BOOLEAN NOT NULL DEFAULT false,
  ttl_days INTEGER,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  source_event_id UUID,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_entry_tenant_agent_idx ON memory_entry(tenant_id, agent_id, created_at DESC);
CREATE INDEX memory_entry_interlocutor_idx ON memory_entry(interlocutor_id) WHERE interlocutor_id IS NOT NULL;
CREATE INDEX memory_entry_scope_idx ON memory_entry(scope_type, subject_id);
CREATE INDEX memory_entry_needs_review_idx ON memory_entry(needs_review) WHERE needs_review = true;
CREATE INDEX memory_entry_expires_idx ON memory_entry(expires_at) WHERE expires_at IS NOT NULL;
