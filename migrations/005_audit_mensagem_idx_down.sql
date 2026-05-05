-- maia:no-transaction
-- Down migration for 005_audit_mensagem_idx.sql
-- WARNING: destructive — review before applying.
-- =====================================================================
-- Drops idx_audit_mensagem (partial index on audit_log.mensagem_id).
--
-- Mirrors the up migration: uses DROP INDEX CONCURRENTLY so it can run
-- against a live table without an ACCESS EXCLUSIVE lock. PostgreSQL
-- rejects DROP INDEX CONCURRENTLY inside a transaction block, hence the
-- `maia:no-transaction` marker for scripts/migrate.ts.
--
-- If applying manually via `psql -f`, do NOT wrap this file in BEGIN/COMMIT.
-- =====================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_audit_mensagem;
