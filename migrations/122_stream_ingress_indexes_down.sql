-- maia:no-transaction
-- Rollback da 119 (issue #505).
--
-- POR QUE ESTE `_down` NÃO TEM `BEGIN`/`COMMIT` — e por que isso NÃO é a
-- omissão que o runbook adverte.
--
-- A regra geral é a do `118_..._down.sql`: `_down` é aplicado com
-- `psql -v ON_ERROR_STOP=1 -f`, que é autocommit por statement, então um
-- arquivo sem envelope pode parar no meio. Aqui o envelope é IMPOSSÍVEL:
-- `DROP INDEX CONCURRENTLY` é recusado pelo Postgres dentro de um bloco de
-- transação, e usar `DROP INDEX` simples para poder envelopar trocaria uma
-- inconsistência hipotética por um lock ACCESS EXCLUSIVE certo sobre
-- `mensagens` — bloqueio de ingresso durante um rollback, que é o pior momento
-- possível para bloquear ingresso. O `_down` da 096 tem exatamente a mesma
-- forma e a mesma justificativa.
--
-- O que compensa a falta do envelope: TODO statement abaixo é idempotente
-- (`IF EXISTS`) e INDEPENDENTE dos demais. Não existe estado intermediário
-- incoerente — apenas "alguns objetos já caíram". Reexecutar o arquivo termina
-- o trabalho, e é o remédio documentado.
--
-- ORDEM: constraints primeiro, índices depois. As CHECK não dependem dos
-- índices, mas derrubá-las antes garante que, se a reexecução parar no meio,
-- o que sobrou de pé é o índice (barato de manter) e não a constraint (que
-- barraria o próximo `_down`, o da 118, ao dropar as colunas).
--
-- NOTA OPERACIONAL: um `DROP INDEX CONCURRENTLY` cancelado deixa o índice em
-- estado inválido. Reexecutar este arquivo o remove.
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.

ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_stream_shadow_chk;

ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_stream_shadow_chk;

DROP INDEX CONCURRENTLY IF EXISTS agent_turns_stream_head_idx;

DROP INDEX CONCURRENTLY IF EXISTS mensagens_stream_ingress_uq;
