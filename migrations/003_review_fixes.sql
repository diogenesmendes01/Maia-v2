-- =====================================================================
-- Maia — Migration 003 (PR review fixes)
-- - Unique index on mensagens.metadata->>'whatsapp_id' (prevents duplicate
--   inbound persistence when Redis dedup is unavailable).
-- - Recovery index on mensagens (created_at) WHERE processada_em IS NULL
--   to make stuck-message recovery cheap.
-- =====================================================================

-- Partial unique index: only enforced when whatsapp_id is present.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mensagens_whatsapp_id
  ON mensagens ((metadata->>'whatsapp_id'))
  WHERE metadata ? 'whatsapp_id';

CREATE INDEX IF NOT EXISTS idx_mensagens_unprocessed
  ON mensagens (created_at)
  WHERE processada_em IS NULL AND direcao = 'in';
