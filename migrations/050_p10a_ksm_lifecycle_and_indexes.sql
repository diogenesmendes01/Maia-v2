-- 050_p10a_ksm_lifecycle_and_indexes.sql
-- P10a — Knowledge State Machine lifecycle columns, indexes, and CHECK constraints.
--
-- This migration is forward-only and idempotent (uses IF NOT EXISTS for
-- columns/indexes and DO blocks for CHECK constraints).
--
-- It does two jobs:
--   (a) Backfill columns normally delivered by P8c (lifecycle_status,
--       evidence_count, confidence, lifecycle_transitions, last_recall_at)
--       in 4 knowledge tables: memory_entry, agent_facts, learned_rules,
--       behavioral_hint. DEFAULT 'active' preserves legacy data.
--   (b) Add the P10a-specific indexes for Admin UI Proposal Inbox
--       (`pending_review`) and auto-promoter eligibility, plus a
--       declarative CHECK that `lifecycle_transitions` is always a JSONB
--       array.
--
-- When P8c lands and writes columns first, the IF NOT EXISTS guards make
-- the migration a no-op for the column ADDs; indexes/CHECK still apply.

BEGIN;

-- ============================================================
-- (a) Columns — defensive backfill (forward-compatible with P8c)
-- ============================================================
ALTER TABLE memory_entry
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_recall_at timestamptz;

ALTER TABLE agent_facts
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_recall_at timestamptz;

ALTER TABLE learned_rules
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_recall_at timestamptz;

ALTER TABLE behavioral_hint
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_recall_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ============================================================
-- (b1) Indexes: Admin UI Proposal Inbox (lifecycle_status='pending_review')
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_memory
  ON memory_entry (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_facts
  ON agent_facts (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_rules
  ON learned_rules (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_hints
  ON behavioral_hint (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

-- ============================================================
-- (b2) Indexes: auto-promoter eligibility (evidence_count + status)
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_memory
  ON memory_entry (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_facts
  ON agent_facts (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_rules
  ON learned_rules (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_hints
  ON behavioral_hint (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

-- ============================================================
-- (b3) CHECK constraints: lifecycle_transitions must be JSONB array
--      Defense-in-depth: KnowledgeStateMachine is the only intended writer,
--      but a bug or direct SQL must not produce a non-array value.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memory_entry_lifecycle_transitions_shape'
  ) THEN
    ALTER TABLE memory_entry
      ADD CONSTRAINT memory_entry_lifecycle_transitions_shape
      CHECK (jsonb_typeof(lifecycle_transitions) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_facts_lifecycle_transitions_shape'
  ) THEN
    ALTER TABLE agent_facts
      ADD CONSTRAINT agent_facts_lifecycle_transitions_shape
      CHECK (jsonb_typeof(lifecycle_transitions) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'learned_rules_lifecycle_transitions_shape'
  ) THEN
    ALTER TABLE learned_rules
      ADD CONSTRAINT learned_rules_lifecycle_transitions_shape
      CHECK (jsonb_typeof(lifecycle_transitions) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'behavioral_hint_lifecycle_transitions_shape'
  ) THEN
    ALTER TABLE behavioral_hint
      ADD CONSTRAINT behavioral_hint_lifecycle_transitions_shape
      CHECK (jsonb_typeof(lifecycle_transitions) = 'array');
  END IF;
END
$$;

COMMIT;
