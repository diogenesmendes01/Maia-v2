-- P2: behavioral_hint derivado de memórias sensíveis (único que entra no prompt)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE behavioral_hint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('conversation', 'interlocutor', 'channel', 'role', 'agent', 'tenant')
  ),
  subject_id TEXT,
  hint_text TEXT NOT NULL,
  derived_from_memory_id UUID REFERENCES memory_entry(id) ON DELETE SET NULL,
  derived_sensitivity TEXT NOT NULL CHECK (
    derived_sensitivity IN ('low', 'medium', 'high')
  ),
  ttl_days INTEGER,
  extension_reason TEXT,
  extension_approved_by TEXT,
  extension_approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX behavioral_hint_tenant_scope_idx ON behavioral_hint(tenant_id, agent_id, scope_type, subject_id);
CREATE INDEX behavioral_hint_active_idx ON behavioral_hint(revoked_at, expires_at);
