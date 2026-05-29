-- maia:no-transaction
-- =====================================================================
-- Maia — Migration 069 DOWN (Issue #316)
-- Drop the relayer hot-path covering index.
--
-- DROP INDEX CONCURRENTLY also cannot run inside a transaction block, so this
-- carries the same -- maia:no-transaction marker. Run manually via `psql -f`
-- (the forward runner skips *_down.sql — see scripts/migrate.ts).
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_idempotency_effect_outbox_tenant_agent_status_next;
