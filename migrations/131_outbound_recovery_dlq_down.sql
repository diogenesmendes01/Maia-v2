-- =====================================================================
-- Maia — Migration 131 DOWN (Issue #633 — fatia D da épica #506)
-- Reverte o estado `dead_letter` e os dois índices de varredura.
--
-- ------------------------------------------------------------------
-- POR QUE O ENVELOPE BEGIN/COMMIT É OBRIGATÓRIO
-- ------------------------------------------------------------------
-- Os `_down.sql` NÃO são executados pelo runner forward
-- (src/migrations/discover.ts filtra `_down`); são aplicados à mão com
-- `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ...`, conforme
-- docs/runbooks/migrations.md §rollback.
--
-- `psql` sem `-1`/`BEGIN` faz AUTOCOMMIT POR STATEMENT. Um `_down` sem
-- envelope que falha no meio é FAIL-OPEN: metade do rollback fica aplicada
-- e o schema não é nem o de antes nem o de depois. Aqui isso seria pior que
-- de costume — se o CHECK estreito entrasse e os índices não caíssem, a
-- varredura de takeover continuaria apontando para um estado que a
-- constraint acabou de proibir.
--
-- Este arquivo NÃO carrega `-- maia:no-transaction`: nenhum statement é
-- CONCURRENTLY, então tudo cabe numa transação. (Se algum dia um índice
-- daqui virar CONCURRENTLY, ele tem que sair PARA OUTRO ARQUIVO — os dois
-- regimes não convivem, e o runner NÃO detecta índice inválido deixado por
-- um CONCURRENTLY cancelado: a verificação é manual, via
-- `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`.)
--
-- ------------------------------------------------------------------
-- A DIREÇÃO QUE PODE FALHAR, E POR QUE ELA FALHA ALTO
-- ------------------------------------------------------------------
-- Ir para frente é seguro (o CHECK só ganha um valor). VOLTAR não é
-- simétrico: se existir row em `dead_letter` no momento do rollback,
-- recriar o CHECK sem esse valor ABORTA.
--
-- Isso é DESEJADO. Reescrever `dead_letter` para `failed_terminal` em
-- silêncio apagaria a distinção entre "o provedor recusou" (nunca rearmar)
-- e "nós desistimos" (rearmamento manual é legítimo) — e é justamente essa
-- distinção que impede um operador de rearmar em massa, depois do
-- rollback, um lote que inclui recusas definitivas. #506 §Rollback é
-- explícito: "voltar por coorte apenas após drenar/conciliar itens
-- `sending` e `unknown`".
--
-- O bloco (0) pré-checa e RAISE com a contagem e a instrução, em vez de
-- deixar um "violates check constraint" genérico aparecer na janela.
-- =====================================================================

BEGIN;

-- ------------------------------------------------------------------
-- (0) Pré-checagem fail-closed e LEGÍVEL.
-- ------------------------------------------------------------------
DO $$
DECLARE
  dl_count bigint;
BEGIN
  SELECT count(*) INTO dl_count FROM outbound_messages WHERE status = 'dead_letter';
  IF dl_count > 0 THEN
    RAISE EXCEPTION
      '131_down: % row(s) em outbound_messages.status = ''dead_letter''. Recriar o CHECK sem esse valor abortaria, e reescreve-las em silencio apagaria a distincao entre recusa definitiva do provedor (failed_terminal, NUNCA rearmar) e desistencia nossa (dead_letter, rearmavel manualmente). Inventarie com: SELECT id, last_error_code, attempt, created_at FROM outbound_messages WHERE status = ''dead_letter'' ORDER BY created_at; e DECIDA row a row (rearmar via `npm run dlq outbound-rearm`, ou promover a failed_terminal) antes de reverter. Ver docs/runbooks/outbound-recovery.md.',
      dl_count;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- (1) Índices. Caem primeiro: são o objeto barato e independente, e se a
--     reexecução do arquivo parar depois disso o que sobra de pé é a
--     constraint larga (que não barra nada), nunca a estreita.
-- ------------------------------------------------------------------
DROP INDEX IF EXISTS idx_outbound_messages_reconcile;
DROP INDEX IF EXISTS idx_outbound_messages_expired_claims;

-- ------------------------------------------------------------------
-- (2) O CHECK volta a ser EXATAMENTE o da 121 (6a) — sem `dead_letter` e
--     COM todo o resto. Reescrever a lista à mão é o erro clássico de down
--     "por lista" em vez de "por diff": omitir aqui um estado da 121
--     derrubaria rows que esta migração nunca criou.
-- ------------------------------------------------------------------
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_status_check;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check CHECK (
    status IN (
      'pending', 'sent', 'failed', 'unknown',
      'claimed', 'sending', 'delivered', 'completed',
      'retryable', 'delivery_unknown', 'reconciling',
      'failed_terminal', 'cancelled'
    )
  );

COMMIT;
