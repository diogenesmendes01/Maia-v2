-- 090 down — reverte a fase 0 do roteamento multi-linha.

-- Dedup: volta à unique GLOBAL de 003 — DATA-AWARE (review PR #496 alto 7).
-- Com dedup POR CANAL o mesmo whatsapp_id pode legitimamente existir em N
-- rows (linhas/tenants diferentes); recriar a unique global às cegas
-- abortaria o rollback no meio. Nenhuma row é APAGADA: nas duplicatas, todas
-- MENOS A MAIS ANTIGA têm a chave movida para
-- 'whatsapp_id_pre_090_rollback' (a mais antiga fica com a chave viva —
-- exatamente a semântica legada de dedup, onde os inserts posteriores teriam
-- sido rejeitados). O valor segue auditável no metadata e recuperável num
-- re-apply manual.
DROP INDEX IF EXISTS uniq_mensagens_channel_whatsapp;
DROP INDEX IF EXISTS uniq_mensagens_tenant_agent_whatsapp;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY metadata->>'whatsapp_id'
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM mensagens
   WHERE metadata ? 'whatsapp_id'
)
UPDATE mensagens m
   SET metadata = (m.metadata - 'whatsapp_id')
                  || jsonb_build_object(
                       'whatsapp_id_pre_090_rollback',
                       m.metadata->>'whatsapp_id'
                     )
  FROM ranked
 WHERE m.id = ranked.id
   AND ranked.rn > 1;

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
