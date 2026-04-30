-- maia:no-transaction
-- =====================================================================
-- Maia — Migration 005 (B2: message-update side-effect detection)
-- Indexes audit_log.mensagem_id so the per-edit lookup stays O(log n)
-- as audit_log grows. Partial — only rows that actually carry a
-- mensagem_id are interesting to this query path.
--
-- The `maia:no-transaction` marker tells scripts/migrate.ts to apply
-- this file outside a BEGIN/COMMIT envelope. PostgreSQL rejects
-- CREATE INDEX CONCURRENTLY inside a transaction block; without the
-- marker the runner would fail with `25001 active SQL transaction`.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_mensagem
  ON audit_log (mensagem_id)
  WHERE mensagem_id IS NOT NULL;
