-- 036_p8c_lifecycle_status.sql
-- P8c — adiciona campos do Knowledge State Machine sem remover legacy.
-- DEFAULT 'active' preserva backward compat: tudo que já existia continua visível.

BEGIN;

-- ============================================================
-- memory_entry
-- ============================================================
ALTER TABLE memory_entry
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN (
      'proposed', 'pending_review', 'ephemeral', 'observed',
      'reinforced', 'verified', 'active', 'deprecated', 'revoked'
    )),
  ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_memory_entry_tenant_lifecycle
  ON memory_entry (tenant_id, lifecycle_status)
  WHERE lifecycle_status IN ('active', 'verified', 'reinforced', 'observed', 'ephemeral');

-- ============================================================
-- agent_facts
-- ============================================================
ALTER TABLE agent_facts
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN (
      'proposed', 'pending_review', 'ephemeral', 'observed',
      'reinforced', 'verified', 'active', 'deprecated', 'revoked'
    )),
  ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions JSONB NOT NULL DEFAULT '[]'::jsonb;
-- agent_facts já possui `confianca` (NUMERIC). Mantemos. Resolver alias para `confidence`.

CREATE INDEX IF NOT EXISTS idx_agent_facts_tenant_lifecycle
  ON agent_facts (tenant_id, lifecycle_status)
  WHERE lifecycle_status IN ('active', 'verified', 'reinforced', 'observed', 'ephemeral');

-- ============================================================
-- learned_rules
-- ============================================================
ALTER TABLE learned_rules
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN (
      'proposed', 'pending_review', 'ephemeral', 'observed',
      'reinforced', 'verified', 'active', 'deprecated', 'revoked'
    )),
  ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions JSONB NOT NULL DEFAULT '[]'::jsonb;
-- learned_rules já possui `confianca`, `acertos`, `erros`. Mantemos. Resolver mapeia.

CREATE INDEX IF NOT EXISTS idx_learned_rules_tenant_lifecycle
  ON learned_rules (tenant_id, lifecycle_status)
  WHERE lifecycle_status IN ('active', 'verified', 'reinforced', 'observed', 'ephemeral');

-- ============================================================
-- behavioral_hint
-- ============================================================
ALTER TABLE behavioral_hint
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN (
      'proposed', 'pending_review', 'ephemeral', 'observed',
      'reinforced', 'verified', 'active', 'deprecated', 'revoked'
    )),
  ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_behavioral_hint_tenant_lifecycle
  ON behavioral_hint (tenant_id, lifecycle_status)
  WHERE lifecycle_status IN ('active', 'verified', 'reinforced', 'observed', 'ephemeral');

COMMIT;
