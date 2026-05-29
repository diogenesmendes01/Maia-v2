-- maia:no-transaction
-- Down migration for 066_ksm_composite_indexes_tenant_agent_id.sql
-- WARNING: destructive — review before applying.
-- =====================================================================
-- Drops the eight KSM lifecycle partial indexes created by the forward
-- migration (two per table across agent_facts, memory_entry,
-- behavioral_hint, learned_rules).
--
-- Mirrors the up migration: uses DROP INDEX CONCURRENTLY so it can run
-- against live tables without an ACCESS EXCLUSIVE lock. PostgreSQL
-- rejects DROP INDEX CONCURRENTLY inside a transaction block, hence the
-- `maia:no-transaction` marker.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain
-- only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. psql runs each statement autonomously, so
-- the multiple DROP statements are fine; if a future runner applies this
-- programmatically it splits no-tx files on `;` (see scripts/migrate.ts).
--
-- If applying manually via `psql -f`, do NOT wrap this file in
-- BEGIN/COMMIT.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_agent_facts_lifecycle_inflight;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_facts_lifecycle_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_memory_entry_lifecycle_inflight;
DROP INDEX CONCURRENTLY IF EXISTS idx_memory_entry_lifecycle_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_behavioral_hint_lifecycle_inflight;
DROP INDEX CONCURRENTLY IF EXISTS idx_behavioral_hint_lifecycle_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_learned_rules_lifecycle_inflight;
DROP INDEX CONCURRENTLY IF EXISTS idx_learned_rules_lifecycle_active;
