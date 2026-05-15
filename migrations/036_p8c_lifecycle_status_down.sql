-- 036_p8c_lifecycle_status_down.sql
-- Reverte 036_p8c_lifecycle_status.sql (forward-only durante janela pré-merge).

BEGIN;

DROP INDEX IF EXISTS idx_memory_entry_tenant_lifecycle;
DROP INDEX IF EXISTS idx_agent_facts_tenant_lifecycle;
DROP INDEX IF EXISTS idx_learned_rules_tenant_lifecycle;
DROP INDEX IF EXISTS idx_behavioral_hint_tenant_lifecycle;

ALTER TABLE memory_entry
  DROP COLUMN IF EXISTS lifecycle_status,
  DROP COLUMN IF EXISTS evidence_count,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS lifecycle_transitions;

ALTER TABLE agent_facts
  DROP COLUMN IF EXISTS lifecycle_status,
  DROP COLUMN IF EXISTS evidence_count,
  DROP COLUMN IF EXISTS lifecycle_transitions;

ALTER TABLE learned_rules
  DROP COLUMN IF EXISTS lifecycle_status,
  DROP COLUMN IF EXISTS evidence_count,
  DROP COLUMN IF EXISTS lifecycle_transitions;

ALTER TABLE behavioral_hint
  DROP COLUMN IF EXISTS lifecycle_status,
  DROP COLUMN IF EXISTS evidence_count,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS lifecycle_transitions;

COMMIT;
