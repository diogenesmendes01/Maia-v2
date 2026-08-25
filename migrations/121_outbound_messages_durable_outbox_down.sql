-- =====================================================================
-- Maia — Migration 121 DOWN (Issue #630 — fatia A da épica #506)
-- Reverte a evolução do ledger `outbound_messages` para outbox durável.
-- WARNING: destrutivo — derruba colunas. Revise antes de aplicar.
--
-- ------------------------------------------------------------------
-- POR QUE O ENVELOPE BEGIN/COMMIT É OBRIGATÓRIO AQUI
-- ------------------------------------------------------------------
-- Os `_down.sql` NÃO são executados pelo runner forward
-- (src/migrations/discover.ts filtra `_down`); eles são aplicados à mão,
-- `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ...`, conforme
-- docs/runbooks/migrations.md §rollback.
--
-- `psql` sem `-1`/`BEGIN` faz AUTOCOMMIT POR STATEMENT. Um `_down` sem
-- envelope que falha no meio é FAIL-OPEN: metade do rollback fica
-- aplicada, `ON_ERROR_STOP=1` interrompe, e o schema fica num estado que
-- não é nem o de antes nem o de depois — e ninguém sabe qual metade
-- sobreviveu. O envelope torna o rollback ATÔMICO: ou volta inteiro, ou
-- não volta nada e o operador lê a mensagem.
--
-- Este arquivo NÃO carrega `-- maia:no-transaction`: nenhum statement é
-- CONCURRENTLY, então tudo cabe numa transação. (Se algum dia um índice
-- daqui virar CONCURRENTLY, ele tem que sair PARA OUTRO ARQUIVO — os dois
-- regimes não convivem.)
--
-- ------------------------------------------------------------------
-- A ÚNICA DIREÇÃO QUE PODE FALHAR, E POR QUE ELA FALHA ALTO
-- ------------------------------------------------------------------
-- Ir para frente é seguro (colunas novas nascem NULL). VOLTAR não é
-- simétrico: o CHECK de status da 063 admitia só
-- pending|sent|failed|unknown. Se, no momento do rollback, existir row em
-- 'claimed'/'sending'/'delivered'/'retryable'/… (gravada pelas fatias
-- #631+), recriar o CHECK estreito ABORTA.
--
-- Isso é DESEJADO, e não um defeito a contornar: reescrever esses estados
-- em silêncio para caber no vocabulário antigo apagaria a distinção entre
-- "o provedor aceitou" e "não sabemos" — exatamente o que causa o reenvio
-- cego que #506 existe para impedir. Então o bloco (0) pré-checa e RAISE
-- com contagem por status e a instrução de drenagem, em vez de deixar o
-- operador decifrar um "violates check constraint" às 3h da manhã.
--
-- #506 §Rollback é explícito: "voltar por coorte apenas após drenar/
-- conciliar itens `sending` e `unknown`" e "não remover constraints/dados
-- antes de garantir que nenhum job depende deles".
-- =====================================================================

BEGIN;

-- ------------------------------------------------------------------
-- (0) Pré-checagem fail-closed e LEGÍVEL.
-- ------------------------------------------------------------------
DO $$
DECLARE
  novos bigint;
  detalhe text;
BEGIN
  SELECT count(*),
         coalesce(string_agg(DISTINCT status, ', ' ORDER BY status), '')
    INTO novos, detalhe
    FROM outbound_messages
   WHERE status NOT IN ('pending', 'sent', 'failed', 'unknown');

  IF novos > 0 THEN
    RAISE EXCEPTION
      '121_down: % row(s) de outbound_messages estao em status do outbox duravel (%), que o CHECK da 063 nao admite. O rollback foi ABORTADO INTEIRO (nada foi alterado). Drene/concilie antes: as fatias #632/#633 levam essas rows a delivered/completed/failed_terminal, e uma row em delivery_unknown exige RECONCILIACAO MANUAL — nunca reenvio cego (issue #506 secao Rollback). Inventario: SELECT status, count(*) FROM outbound_messages GROUP BY 1 ORDER BY 1;',
      novos, detalhe;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- (1) Índices novos. `CREATE INDEX IF NOT EXISTS` na ida ⇒ `DROP INDEX
--     IF EXISTS` na volta: reaplicar 121 depois deste down é idempotente.
--     Os índices da 063/067 (idx_outbound_messages_tenant_created e
--     idx_outbound_messages_tenant_agent_status_created) NÃO são tocados —
--     são de outras migrações e o down delas é que responde por eles.
-- ------------------------------------------------------------------
DROP INDEX IF EXISTS idx_outbound_messages_ready;
DROP INDEX IF EXISTS outbound_messages_turn_sequence_uq;
DROP INDEX IF EXISTS outbound_messages_logical_dedupe_uq;

-- ------------------------------------------------------------------
-- (2) CHECKs acrescentados pela 121.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_claim_complete_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_json_size_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_last_error_code_len_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_hash_format_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_version_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_attempt_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_sequence_in_turn_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_durable_row_complete_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_delivery_outcome_check;
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_payload_type_check;

-- ------------------------------------------------------------------
-- (3) CHECKs que a 121 SUBSTITUIU (não criou): restaurar exatamente o
--     texto da 063. Se estes dois não voltarem ao original, o rollback
--     estaria deixando a tabela mais PERMISSIVA do que antes — um rollback
--     que afrouxa invariante é pior que nenhum rollback.
--     O CHECK de status abaixo só pode ser criado porque o bloco (0)
--     garantiu que não há row fora do vocabulário da 063.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_channel_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_channel_check
  CHECK (channel IN ('text', 'voice', 'document', 'poll'));

ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'unknown'));

-- ------------------------------------------------------------------
-- (4) FK composta e colunas. A FK sai ANTES das colunas (dropar a coluna
--     levaria a constraint junto, mas explícito é auditável).
--     `provider_message_id` NÃO aparece aqui: ela é da 063, a 121 só a
--     reaproveitou. Dropá-la aqui destruiria dado que esta migração nunca
--     criou — o erro clássico de down escrito por lista de colunas em vez
--     de por diff.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_turn_scope_fk;

ALTER TABLE outbound_messages DROP COLUMN IF EXISTS delivery_outcome;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS last_error_code;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS provider_timestamp;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS next_attempt_at;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS claim_token;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS attempt;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS provider_idempotency_key;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS logical_dedupe_key;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS payload_hash;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS payload_json;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS payload_type;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS payload_version;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS sequence_in_turn;
ALTER TABLE outbound_messages DROP COLUMN IF EXISTS turn_id;

COMMIT;
