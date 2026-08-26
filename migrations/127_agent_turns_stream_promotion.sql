-- 127 — a DECISÃO de promoção do sucessor, persistida (issue #627, fatia D da
-- #505; fase 6 do rollout da issue-mãe).
--
-- ─── O que esta migration existe para tornar possível ──────────────────────
--
-- A cláusula central da fatia é literal na issue: "**persistir a decisão antes
-- de sinalizar a BullMQ**" e "permitir que o recovery reconcilie o caso *commit
-- feito, enqueue não feito*". As duas frases dizem a mesma coisa por ângulos
-- opostos: a BullMQ é WAKE-UP, não fonte de verdade. Se o processo cai entre o
-- COMMIT da promoção e o `enqueueAgent`, o turno promovido existe no banco e
-- não existe na fila — e só um recovery que consulta o BANCO recupera isso.
--
-- Para o recovery poder distinguir "este turno está `queued` desde o ingresso"
-- de "este turno foi PROMOVIDO e o sinal pode ter se perdido", a decisão tem de
-- ser um DADO, não um efeito. Daí as duas colunas.
--
-- ─── Por que `promoted_at` não é redundante com `queued_at` ────────────────
--
-- `queued_at` responde "quando este turno entrou na fila pela primeira vez" e
-- alimenta a idade do head. A promoção NÃO o reescreve: um sucessor que já
-- estava `queued` desde o ingresso (o caso NORMAL — todo turno é enfileirado no
-- ingresso, o job acorda, o claim recusa com `not_head` e o job TERMINA) é
-- re-armado sem que seu tempo de espera seja apagado. Se a promoção carimbasse
-- `queued_at`, a métrica de espera do head passaria a medir o tempo desde a
-- última promoção, e uma conversa presa há uma hora pareceria recém-chegada —
-- exatamente o sinal que a issue-mãe manda vigiar (`maia_stream_head_age_seconds`).
--
-- `promoted_at` responde outra pergunta: "este turno foi eleito para avançar, e
-- alguém DEVE um wake-up a ele?". É a coluna que o varredor lê para reconciliar.
--
-- ─── Por que `promoted_by_turn_id` é NULLABLE, e o que NULL significa ──────
--
-- Há DOIS produtores de promoção, e eles se distinguem por esta coluna:
--
--   * PREENCHIDA — o predecessor chegou a estado TERMINAL e, na MESMA
--     transação do CAS terminal, elegeu o sucessor. `promoted_by_turn_id` é o
--     turno que terminou. É o caminho da issue ("quando o head-of-line chega a
--     estado terminal").
--   * NULL — o turno foi re-armado pela RECUPERAÇÃO de claim expirado da
--     própria stream (a metade temporal da fatia B, #625). Aqui não existe
--     "quem promoveu": o dono morreu, e a transação do claim de um sucessor
--     devolveu este turno a `retryable`. Escrever o turno do sucessor aqui
--     seria mentira — ele não promoveu ninguém; ele foi RECUSADO.
--
-- SEM foreign key, e é deliberado: `superseded_by_turn_id` (migration 097)
-- também não tem, pela mesma razão — a coluna é FORENSE, e uma FK
-- transformaria a limpeza de histórico de um turno antigo numa falha de
-- integridade em cima de um turno vivo. A integridade que importa aqui (o
-- promotor e o promovido são da MESMA stream e do MESMO escopo) é garantida
-- pela consulta que escreve, não por constraint — ver
-- `src/db/repositories/stream-head-sql.ts`.
--
-- ─── Por que NÃO há índice novo ───────────────────────────────────────────
--
-- A pergunta do varredor é "quais turnos recuperáveis deste par (tenant,agent)"
-- — e ela já é servida por `agent_turns_scope_status_next_attempt_idx` (097) e
-- pelo parcial do head-of-line (126). `promoted_at` é lido como COLUNA da linha
-- já encontrada, nunca como predicado de busca: filtrar por ele não reduz o
-- conjunto (o varredor precisa varrer os recuperáveis de qualquer jeito) e um
-- índice a mais só custaria escrita numa tabela quente.
--
-- Consequência prática, e ela é boa: esta migration NÃO usa
-- `CREATE INDEX CONCURRENTLY`, então não está exposta à armadilha da issue #658
-- (um `CONCURRENTLY` que falha deixa `pg_index.indisvalid = false` e reaplicar
-- devolve exit 0, marcando a migration como aplicada SEM o índice). Aqui o
-- efeito é um `ALTER TABLE ... ADD COLUMN` nullable e sem default — que no
-- PostgreSQL 11+ é metadata-only, não reescreve a tabela, e toma o ACCESS
-- EXCLUSIVE por microssegundos.
--
-- Ver docs/runbooks/turn-state-machine.md §12.

BEGIN;

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_by_turn_id uuid;

COMMENT ON COLUMN agent_turns.promoted_at IS
  'issue 627: instante em que este turno foi ELEITO para avancar (promocao do sucessor ou re-arme de claim expirado da stream). A decisao e persistida ANTES do sinal da BullMQ; se o processo cair entre o commit e o enqueue, e esta coluna que permite ao recovery reconciliar. NULL = nunca promovido.';

COMMENT ON COLUMN agent_turns.promoted_by_turn_id IS
  'issue 627: o turno PREDECESSOR que promoveu este ao chegar a estado terminal. NULL quando a promocao veio da recuperacao de claim expirado da propria stream (nao ha promotor: o dono morreu). Sem FK, como superseded_by_turn_id — a coluna e forense.';

COMMIT;
