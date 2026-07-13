-- 090 down — reverte a fase 0 do roteamento multi-linha.

-- Dedup: volta à unique GLOBAL de 003 (recriada idêntica).
DROP INDEX IF EXISTS uniq_mensagens_channel_whatsapp;
DROP INDEX IF EXISTS uniq_mensagens_tenant_agent_whatsapp;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mensagens_whatsapp_id
  ON mensagens ((metadata->>'whatsapp_id'))
  WHERE metadata ? 'whatsapp_id';

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_channel_scope_fk;
ALTER TABLE mensagens DROP COLUMN IF EXISTS channel_id;

ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_sendable_requires_channel;
-- Rows bloqueadas pelo backfill voltam a pending (o operador decide de novo
-- no re-apply; nenhuma informação é perdida — last_error preserva a marca).
UPDATE outbox_messages SET status = 'pending'
 WHERE status = 'blocked_channel_unresolved';
ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_channel_scope_fk;
ALTER TABLE outbox_messages DROP COLUMN IF EXISTS channel_id;

DROP INDEX IF EXISTS idx_conversas_channel;
ALTER TABLE conversas DROP CONSTRAINT IF EXISTS conversas_channel_scope_fk;
ALTER TABLE conversas DROP COLUMN IF EXISTS channel_id;

DROP INDEX IF EXISTS channels_tenant_agent_id_uq;
