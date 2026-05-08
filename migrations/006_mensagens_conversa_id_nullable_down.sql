-- Rollback for 006_mensagens_conversa_id_nullable.sql.
-- WARNING: fails if any existing row has conversa_id IS NULL — operator
-- must `DELETE FROM mensagens WHERE conversa_id IS NULL` (or attach
-- those orphans to a conversa) before running this.

ALTER TABLE mensagens ALTER COLUMN conversa_id SET NOT NULL;
