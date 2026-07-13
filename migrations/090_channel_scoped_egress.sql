-- 090 — Fase 0 do roteamento multi-linha (spec 2026-07-09-multi-agent-channel-routing, Draft v4 §1.6/§1.7).
--
-- Escopo desta migração:
--   1. Índice único de SUPORTE em channels(tenant_id, agent_id, id) para as
--      FKs compostas — uma row de conversas/outbox/mensagens nunca aponta
--      para canal de outro tenant/agente, por construção.
--   2. conversas.channel_id — identidade da conversa passa a incluir o canal
--      (mesma pessoa em duas linhas = duas conversas). Legado fica NULL e
--      casa qualquer canal do agente até encerrar (janela documentada na spec).
--   3. outbox_messages.channel_id + CHECK de bloqueio expressável: rows
--      ENVIÁVEIS (pending/claimed) exigem canal; rows não-deriváveis viram
--      status='blocked_channel_unresolved' no backfill (o drain as ignora) —
--      NUNCA escolher um canal "primário" silenciosamente.
--   4. mensagens.channel_id + substituição da UNIQUE GLOBAL de whatsapp_id
--      (003_review_fixes.sql) por partial uniques escopadas: com N linhas,
--      IDs de sessões diferentes podem colidir — a unique global descartaria
--      mensagem de outro tenant/linha (review v4, bloqueante 1).
--
-- Backfill fail-closed (review v3/v4): channel_id só é derivado quando o
-- agente tem EXATAMENTE UM canal ativo do tipo; caso contrário a row de
-- outbox enviável fica bloqueada para resolução manual (runbook
-- docs/runbooks/outbox-blocked-channel.md).

-- (1) Suporte para FKs compostas.
CREATE UNIQUE INDEX IF NOT EXISTS channels_tenant_agent_id_uq
  ON channels (tenant_id, agent_id, id);

-- (2) conversas.channel_id.
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS channel_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversas_channel_scope_fk'
  ) THEN
    ALTER TABLE conversas
      ADD CONSTRAINT conversas_channel_scope_fk
      FOREIGN KEY (tenant_id, agent_id, channel_id)
      REFERENCES channels (tenant_id, agent_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_conversas_channel
  ON conversas (channel_id) WHERE channel_id IS NOT NULL;

-- (3) outbox_messages.channel_id + backfill fail-closed + CHECK.
ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS channel_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outbox_channel_scope_fk'
  ) THEN
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_channel_scope_fk
      FOREIGN KEY (tenant_id, agent_id, channel_id)
      REFERENCES channels (tenant_id, agent_id, id);
  END IF;
END $$;

-- Backfill: canal unívoco (exatamente 1 ativo para o agente) ⇒ deriva;
-- ambíguo/zero ⇒ rows ENVIÁVEIS ficam bloqueadas. Rows terminais
-- (sent/failed/dead) permanecem NULL — são histórico, o drain não as toca.
-- Escopo: SÓ kinds whatsapp (o canal é a LINHA de saída) — email_alert e
-- afins não têm linha e permanecem NULL sem bloqueio.
WITH unico AS (
  SELECT tenant_id, agent_id, MIN(id::text)::uuid AS channel_id
    FROM channels
   WHERE active
   GROUP BY tenant_id, agent_id
  HAVING COUNT(*) = 1
)
UPDATE outbox_messages o
   SET channel_id = u.channel_id
  FROM unico u
 WHERE o.channel_id IS NULL
   AND o.kind LIKE 'whatsapp%'
   AND o.tenant_id = u.tenant_id
   AND o.agent_id = u.agent_id;

UPDATE outbox_messages
   SET status = 'blocked_channel_unresolved',
       last_error = COALESCE(last_error, '') ||
         ' [090] channel_id não derivável de forma unívoca; resolução manual (runbook outbox-blocked-channel)'
 WHERE channel_id IS NULL
   AND kind LIKE 'whatsapp%'
   AND status IN ('pending', 'claimed');

-- Regra expressável (review v4): row whatsapp enviável exige canal. Kinds sem
-- linha (email), terminais e bloqueadas podem ficar sem canal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outbox_sendable_requires_channel'
  ) THEN
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_sendable_requires_channel
      CHECK (
        channel_id IS NOT NULL
        OR kind NOT LIKE 'whatsapp%'
        OR status NOT IN ('pending', 'claimed')
      );
  END IF;
END $$;

-- (4) mensagens.channel_id + dedup por canal.
ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS channel_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mensagens_channel_scope_fk'
  ) THEN
    ALTER TABLE mensagens
      ADD CONSTRAINT mensagens_channel_scope_fk
      FOREIGN KEY (tenant_id, agent_id, channel_id)
      REFERENCES channels (tenant_id, agent_id, id);
  END IF;
END $$;

-- Substitui a unique GLOBAL (003) pelas escopadas. Rows novas (canal
-- conhecido pós-resolução) dedupam por (channel, whatsapp_id); legado sem
-- canal preserva a proteção por (tenant, agent, whatsapp_id) — a global
-- antiga implicava essa propriedade, então a criação não pode falhar.
DROP INDEX IF EXISTS uniq_mensagens_whatsapp_id;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mensagens_channel_whatsapp
  ON mensagens (channel_id, (metadata->>'whatsapp_id'))
  WHERE channel_id IS NOT NULL AND metadata ? 'whatsapp_id';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mensagens_tenant_agent_whatsapp
  ON mensagens (tenant_id, agent_id, (metadata->>'whatsapp_id'))
  WHERE channel_id IS NULL AND metadata ? 'whatsapp_id';
