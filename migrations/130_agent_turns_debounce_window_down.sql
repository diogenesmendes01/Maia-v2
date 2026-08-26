-- maia:no-transaction
-- Rollback da 130 (issue #628, fatia E da #505).
--
-- ─── O QUE ESTE ROLLBACK É, E O QUE ELE NÃO É ─────────────────────────────
--
-- Ele apaga a JANELA persistida. Ele NÃO religa o debounce em memória: quem
-- decide qual debounce roda é a flag `FEATURE_TURN_STREAM_DEBOUNCE`, não este
-- arquivo. Rodar este `_down` com a flag LIGADA derruba o ingresso — o UPDATE
-- que abre a janela referencia colunas que deixaram de existir, e ele roda
-- DENTRO da transação que persiste a mensagem.
--
-- **Ordem obrigatória num rollback de verdade:**
--   1. `FEATURE_TURN_STREAM_DEBOUNCE=false` e reinicie as réplicas;
--   2. confirme que nenhuma janela ficou ABERTA e vencida —
--      `SELECT count(*) FROM agent_turns
--        WHERE debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL;`
--      Com a flag OFF o varredor não roda mais, então uma janela aberta aqui é
--      uma rajada que NUNCA será fechada: os turnos ficam `received` e quem os
--      rearma passa a ser o recovery por estado (`STUCK_AFTER_MS`, 2 min), sem
--      agregação. Nenhuma mensagem se perde; a rajada vira N turnos em ordem;
--   3. só então derrube as colunas.
--
-- ─── O que se PERDE ───────────────────────────────────────────────────────
--
-- Perde-se `debounce_batch_size` — a evidência de quantos ingressos cada
-- resposta consumiu. A composição do batch continua reconstruível pelos turnos
-- `superseded` com `superseded_by_turn_id` (migration 097), que este `_down`
-- não toca; o que some é o número já consolidado.
--
-- ─── POR QUE NÃO HÁ ENVELOPE `BEGIN`/`COMMIT` ────────────────────────────
--
-- A regra geral do repositório manda envelopar todo `_down` — o runner usa
-- `psql -v ON_ERROR_STOP=1 -f`, autocommit por statement, e sem envelope um
-- arquivo que falha no meio deixa um rollback pela metade. A exceção aqui é a
-- mesma da 126: `DROP INDEX CONCURRENTLY` é RECUSADO pelo PostgreSQL dentro de
-- bloco de transação, e trocá-lo por `DROP INDEX` simples para poder envelopar
-- tomaria ACCESS EXCLUSIVE sobre `agent_turns` — bloqueando claim, transição e
-- conclusão no meio de um rollback, que é o pior momento possível.
--
-- O que compensa: os dois statements são idempotentes (`IF EXISTS`) e a ORDEM
-- é a segura — o índice PRIMEIRO, as colunas depois. Se o processo morrer entre
-- os dois, o estado é "colunas sem índice", que é funcional (só lento) e que
-- reexecutar conserta. A ordem inversa também funcionaria (derrubar a coluna
-- derruba o índice que a usa), mas deixaria a janela em que o índice existe
-- sobre uma coluna em vias de sumir.
--
-- NOTA OPERACIONAL: um `DROP INDEX CONCURRENTLY` cancelado no meio deixa o
-- índice INVÁLIDO (`pg_index.indisvalid = false`): para de servir leitura e
-- continua custando escrita. Reexecutar este arquivo o remove.
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.

DROP INDEX CONCURRENTLY IF EXISTS agent_turns_debounce_due_idx;

ALTER TABLE agent_turns
  DROP COLUMN IF EXISTS debounce_batch_size,
  DROP COLUMN IF EXISTS debounce_closed_at,
  DROP COLUMN IF EXISTS debounce_deadline_at,
  DROP COLUMN IF EXISTS debounce_window_opened_at;
