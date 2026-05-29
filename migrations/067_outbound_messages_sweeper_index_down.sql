-- maia:no-transaction
-- Down migration for 067_outbound_messages_sweeper_index.sql
-- WARNING: destructive — review before applying.
-- =====================================================================
-- Drops the sweeper hot-path covering index created by the forward
-- migration.
--
-- Mirrors the up migration: uses DROP INDEX CONCURRENTLY so it can run
-- against the live outbound_messages table without an ACCESS EXCLUSIVE
-- lock. PostgreSQL rejects DROP INDEX CONCURRENTLY inside a transaction
-- block, hence the `maia:no-transaction` marker.
--
-- The `_down.sql` files are skipped by scripts/migrate.ts (forward chain
-- only); they are applied manually via `psql -f` per
-- docs/runbooks/migrations.md. If applying manually, do NOT wrap this file
-- in BEGIN/COMMIT.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_outbound_messages_tenant_agent_status_created;
