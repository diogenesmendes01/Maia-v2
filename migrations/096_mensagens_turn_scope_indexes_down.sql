-- maia:no-transaction
-- Rollback da 096. DROP CONCURRENTLY para não bloquear o ingresso.
--
-- PRÉ-CONDIÇÃO: a 097 já foi revertida (a FK composta
-- `agent_turn_inputs_mensagem_scope_fk` depende de
-- `uniq_mensagens_tenant_agent_id`; derrubar o índice antes falha).
--
-- Rodar manualmente via psql -f, nunca automaticamente durante incidente
-- (ver docs/runbooks/migrations.md).

DROP INDEX CONCURRENTLY IF EXISTS idx_mensagens_inbound_scope_created;
DROP INDEX CONCURRENTLY IF EXISTS uniq_mensagens_tenant_agent_id;
