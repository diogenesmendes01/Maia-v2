-- 139 — escopo composto em `approval_requests`, alvo da FK do journal de
-- execução do engine (spec Maia+Hermes §5.6.2).
--
-- ─── Por que esta constraint precisa existir ────────────────────────────────
--
-- `engine_tool_calls` (migration 140) guarda a aprovação que uma chamada exigiu
-- e referencia `approval_requests` por FK **COMPOSTA** `(tenant_id, agent_id,
-- approval_request_id)`. Composta, e não por `id` simples, pelo motivo de
-- sempre neste repositório: uma FK de UUID sozinho aceita alegremente uma linha
-- de OUTRO tenant. O UUID prova unicidade, não pertencimento.
--
-- O Postgres só aceita uma FK composta se existir unique/PK exatamente sobre
-- aquelas colunas. Hoje `approval_requests` tem apenas `PRIMARY KEY (id)` —
-- conferido no banco, não presumido do ORM. A spec manda checar antes de
-- nomear (§5.6.2, "Verificar se alguma migração posterior já o criou").
--
-- É o mesmo desenho que `agent_turns_scope_id_uq` já usa desde a 097, e é ele
-- que permite às FKs compostas da 140 apontarem para o turno.
--
-- ─── Por que SEM `CONCURRENTLY` ─────────────────────────────────────────────
--
-- `ADD CONSTRAINT ... UNIQUE` constrói o índice sob ACCESS EXCLUSIVE. A
-- alternativa (índice `CONCURRENTLY` + `ADD CONSTRAINT ... USING INDEX`) exige
-- o modo `-- maia:no-transaction`, e aí o arquivo inteiro perde a atomicidade
-- com a linha do ledger, além de ficar sujeito ao divisor por `;` sem parser.
--
-- A troca vale a pena aqui porque a tabela é PEQUENA e recente: nasceu na
-- migration 095 e guarda pedidos de aprovação humana, não tráfego. O bloqueio é
-- de milissegundos. Se algum dia esta tabela virar tabela quente, o caminho
-- correto passa a ser o par CONCURRENTLY + USING INDEX, em arquivo próprio.

BEGIN;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_scope_id_uq UNIQUE (tenant_id, agent_id, id);

COMMENT ON CONSTRAINT approval_requests_scope_id_uq ON approval_requests IS
  'spec maia-hermes 5.6.2: alvo da FK COMPOSTA de engine_tool_calls. Uma FK por id simples aceitaria uma aprovacao de outro tenant — o UUID prova unicidade, nao pertencimento.';

COMMIT;
