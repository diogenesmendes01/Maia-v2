-- Rollback da 127 (issue #627, fatia D da #505).
--
-- ─── O QUE ESTE ROLLBACK É, E O QUE ELE NÃO É ─────────────────────────────
--
-- Ele apaga a TRILHA da promoção. Ele NÃO desliga a promoção: quem promove é
-- código (`promoteStreamSuccessor`, em src/db/repositories/turn-repos.ts), e o
-- kill switch da fatia é a flag `FEATURE_TURN_STREAM_PROMOTION=false`, não este
-- arquivo. Rodar este `_down` com a flag LIGADA derruba a aplicação: o UPDATE
-- da promoção referencia colunas que deixaram de existir.
--
-- **Ordem obrigatória num rollback de verdade:** desligue a flag PRIMEIRO,
-- confirme que as réplicas recarregaram, e só então derrube as colunas.
--
-- ─── O que se PERDE, e por que isso é aceitável ───────────────────────────
--
-- Perde-se a capacidade de o varredor distinguir "turno `queued` desde o
-- ingresso" de "turno promovido cujo wake-up pode ter se perdido". A
-- recuperação em si NÃO se perde: um turno promovido e não enfileirado continua
-- sendo um turno recuperável por ESTADO (`queued`/`retryable` parado), e o
-- varredor o rearma pelo caminho de sempre — só sem contar
-- `maia_stream_promotion_total{result="recovered"}` nem auditar a
-- reconciliação. Volta-se à latência de `STUCK_AFTER_MS` (2 min) do crash,
-- que é exatamente o estado da fatia C.
--
-- ─── POR QUE HÁ ENVELOPE `BEGIN`/`COMMIT` ────────────────────────────────
--
-- O runner aplica com `psql -v ON_ERROR_STOP=1 -f`, que é AUTOCOMMIT POR
-- STATEMENT. Sem envelope, um arquivo com dois statements que falha no segundo
-- deixa o primeiro COMITADO — um rollback pela metade, que é a forma mais cara
-- de fail-open que existe num `_down`. Aqui os dois `DROP COLUMN` são um átomo:
-- ou as duas colunas somem, ou nenhuma some.
--
-- (A 126 e a 124 não têm envelope porque `CREATE/DROP INDEX CONCURRENTLY` é
-- RECUSADO pelo PostgreSQL dentro de bloco de transação. `ALTER TABLE ... DROP
-- COLUMN` não tem essa restrição, então aqui a regra geral do repositório vale
-- sem exceção.)
--
-- Idempotente (`IF EXISTS`): reexecutar é seguro.
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.

BEGIN;

ALTER TABLE agent_turns
  DROP COLUMN IF EXISTS promoted_by_turn_id,
  DROP COLUMN IF EXISTS promoted_at;

COMMIT;
