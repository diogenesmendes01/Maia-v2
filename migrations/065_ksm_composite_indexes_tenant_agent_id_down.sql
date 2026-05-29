-- maia:no-transaction
-- Down migration for 065_ksm_composite_indexes_tenant_agent_id.sql
-- WARNING: destructive — review before applying.
-- =====================================================================
-- Drops the three composite indexes created by the forward migration.
--
-- Mirrors the up migration: uses DROP INDEX CONCURRENTLY so it can run
-- against live tables without an ACCESS EXCLUSIVE lock. PostgreSQL
-- rejects DROP INDEX CONCURRENTLY inside a transaction block, hence
-- the `maia:no-transaction` marker.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward
-- chain only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md.
--
-- If applying manually via `psql -f`, do NOT wrap this file in
-- BEGIN/COMMIT.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_agent_facts_tenant_agent_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_memory_entry_tenant_agent_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_behavioral_hint_tenant_agent_id;
