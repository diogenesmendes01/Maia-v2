-- Down migration for 004_pending_one_active_per_conversa.sql
-- WARNING: destructive — review before applying. Run in transaction.
-- =====================================================================
-- Reverts:
--   - drops the partial unique index that enforces one 'aberta' pending
--     per conversa
--   - drops the metadata column added to pending_questions
--
-- Dropping the metadata column will discard any cancel_reason / lost_race
-- audit data stamped by the pre-LLM gate. Back up first if that history
-- matters.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS uniq_pending_questions_active_per_conversa;

ALTER TABLE pending_questions DROP COLUMN IF EXISTS metadata;

COMMIT;
