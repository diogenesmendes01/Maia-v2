-- =====================================================================
-- Maia — Migration 068 DOWN (Issue #316)
-- Rollback of the transactional effect outbox.
--
-- Run manually via `psql -f` (the forward runner skips *_down.sql — see
-- scripts/migrate.ts). Dropping the table cascades its indexes/constraints.
-- WARNING: any still-pending outbox rows are LOST on a down-migration; drain
-- the relayer (or accept that un-relayed effects will not fire) before
-- rolling back in an environment with live traffic.
-- =====================================================================

DROP TABLE IF EXISTS idempotency_effect_outbox;
