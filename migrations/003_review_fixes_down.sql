-- Down migration for 003_review_fixes.sql
-- WARNING: destructive — review before applying. Run in transaction.
-- =====================================================================
-- Drops the two indexes added on mensagens:
--   - uniq_mensagens_whatsapp_id (unique on metadata->>'whatsapp_id')
--   - idx_mensagens_unprocessed  (recovery index)
-- The mensagens table itself is preserved.
-- =====================================================================

BEGIN;

DROP INDEX IF EXISTS idx_mensagens_unprocessed;
DROP INDEX IF EXISTS uniq_mensagens_whatsapp_id;

COMMIT;
