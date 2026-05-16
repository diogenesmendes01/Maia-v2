-- Down migration for 036 — P10a KSM lifecycle + indexes.
-- Idempotent: uses IF EXISTS for all drops.

BEGIN;

-- Drop CHECK constraints
ALTER TABLE behavioral_hint DROP CONSTRAINT IF EXISTS behavioral_hint_lifecycle_transitions_shape;
ALTER TABLE learned_rules   DROP CONSTRAINT IF EXISTS learned_rules_lifecycle_transitions_shape;
ALTER TABLE agent_facts     DROP CONSTRAINT IF EXISTS agent_facts_lifecycle_transitions_shape;
ALTER TABLE memory_entry    DROP CONSTRAINT IF EXISTS memory_entry_lifecycle_transitions_shape;

-- Drop auto-promoter indexes
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_hints;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_rules;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_facts;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_memory;

-- Drop pending_review indexes
DROP INDEX IF EXISTS knowledge_pending_review_idx_hints;
DROP INDEX IF EXISTS knowledge_pending_review_idx_rules;
DROP INDEX IF EXISTS knowledge_pending_review_idx_facts;
DROP INDEX IF EXISTS knowledge_pending_review_idx_memory;

-- Note: We do NOT drop the lifecycle_status / evidence_count / confidence /
-- lifecycle_transitions / last_recall_at columns on rollback. P8c is expected
-- to own those columns; dropping them here could conflict with concurrent
-- P8c rollout. If a full P10a rollback is needed alongside removal of those
-- columns, drop them in a separate ad-hoc migration after coordinating with
-- P8c owners.

COMMIT;
