-- Rollback da 133 (issue #629, fatia F da #505).
--
-- ─── O QUE ESTE ROLLBACK É, E O QUE ELE NÃO É ─────────────────────────────
--
-- Ele apaga a capacidade de BLOQUEAR uma stream. Ele NÃO desliga a política:
-- quem decide bloquear é código (`poisonDisposition`, em
-- src/runtime/turns/poison-policy.ts, lido por `deadLetterTurn`), e o kill
-- switch da fatia é `TURN_POISON_BLOCK_CATEGORIES=` (lista VAZIA) + restart —
-- não este arquivo. Rodar este `_down` com categorias configuradas derruba a
-- conclusão de todo turno envenenado: o INSERT do bloqueio referencia uma
-- tabela que deixou de existir, e a transação do CAS terminal inteira falha.
--
-- **Ordem obrigatória num rollback de verdade:**
--   1. `TURN_POISON_BLOCK_CATEGORIES=` (vazio) e restart das réplicas;
--   2. confirme que não há bloqueio ATIVO — cada um é uma conversa parada que
--      este DROP faria voltar a andar SEM ninguém ter decidido isso:
--        SELECT count(*) FROM agent_stream_blocks WHERE unblocked_at IS NULL;
--      o esperado é 0. Cada linha devolvida deve ser desbloqueada pelo caminho
--      normal (`npm run dlq -- unblock`), nunca por este DROP;
--   3. só então rode este arquivo.
--
-- ─── O que se PERDE ───────────────────────────────────────────────────────
--
-- O HISTÓRICO inteiro de envenenamento — inclusive os bloqueios já resolvidos,
-- que são o que responde "esta conversa já parou por isto antes?". Não há como
-- preservá-lo derrubando a tabela, e uma tabela órfã mantida "por precaução"
-- seria um schema que mente sobre o que a aplicação faz.
--
-- Nenhum turno muda de estado: `dead_letter` continua terminal, e as conversas
-- que estavam bloqueadas voltam a andar pelo predicado de head-of-line — que é
-- exatamente o comportamento da #627.
--
-- ─── POR QUE HÁ ENVELOPE `BEGIN`/`COMMIT` ────────────────────────────────
--
-- O runner aplica com `psql -v ON_ERROR_STOP=1 -f`, que é AUTOCOMMIT POR
-- STATEMENT. Sem envelope, um arquivo com mais de um statement que falha no
-- segundo deixa o primeiro COMITADO — um rollback pela metade. Aqui o `DROP
-- TABLE` leva os dois índices junto, então o átomo é natural; o envelope
-- permanece porque a regra do repositório é essa, e uma exceção não
-- documentada é como a próxima migration perde o envelope por imitação.
--
-- Idempotente (`IF EXISTS`): reexecutar é seguro.
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.

BEGIN;

DROP TABLE IF EXISTS agent_stream_blocks;

COMMIT;
