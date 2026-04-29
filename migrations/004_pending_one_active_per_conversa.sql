-- =====================================================================
-- Maia — Migration 004 (B0: pending-question lifecycle wiring)
-- Enforces "one active pending per conversa" at the DB level, so the
-- pre-LLM gate (src/agent/pending-gate.ts) never sees ambiguous state.
--
-- Failure mode: if any conversa already has multiple 'aberta' rows when
-- this applies, index creation fails with a duplicate-key error. Run
-- scripts/recover-pending-dupes.sql once, then re-apply this migration.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_questions_active_per_conversa
  ON pending_questions (conversa_id)
  WHERE status = 'aberta';

-- pending_questions does not currently have a metadata column. The pre-LLM
-- gate stamps cancel_reason / lost_race / etc. into this column for audit
-- and debugging.
ALTER TABLE pending_questions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
