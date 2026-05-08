-- =====================================================================
-- Maia — Migration 006 (debounce: nullable conversa_id on mensagens)
-- Aligns the DB constraint with what the code already assumes.
--
-- Background: src/gateway/baileys.ts:251 inserts inbound rows with
-- conversa_id = null and runAgentForMensagem resolves it later via
-- mensagensRepo.setConversaId. Migration 001 declared the column
-- NOT NULL, which would block that insert path. The code path was
-- only working in mocked unit tests; integration runs (skipped without
-- TEST_DB_URL) would have caught it. Surfaced while wiring the
-- debounce-flow integration spec (#54).
--
-- The down script restores NOT NULL — only safe if no rows currently
-- have a null conversa_id (operator must clean up first).
-- =====================================================================

ALTER TABLE mensagens ALTER COLUMN conversa_id DROP NOT NULL;
