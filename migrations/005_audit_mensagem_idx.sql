-- =====================================================================
-- Maia — Migration 005 (B2: message-update side-effect detection)
-- Indexes audit_log.mensagem_id so the per-edit lookup stays O(log n)
-- as audit_log grows. Partial — only rows that actually carry a
-- mensagem_id are interesting to this query path.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_mensagem
  ON audit_log (mensagem_id)
  WHERE mensagem_id IS NOT NULL;
