-- Rollback da 097 (issue #503).
--
-- DESTRUTIVO: apaga toda a trilha de turnos. Só executar quando TODAS as
-- pré-condições do plano de rollback da issue valerem:
--   * nenhuma versão nova da aplicação rodando (dual-write desligado);
--   * nenhum turno em estado NÃO terminal (senão trabalho em voo se perde);
--   * backup validado;
--   * runtime de volta à leitura legada (`mensagens.processada_em`).
--
-- Nunca rodar automaticamente durante incidente — ver docs/runbooks/migrations.md.
--
-- `processada_em` nunca foi removido, então o caminho legado permanece íntegro
-- após este down: derrubar as tabelas não perde nenhuma mensagem.

DROP TABLE IF EXISTS agent_turn_inputs;
DROP TABLE IF EXISTS agent_turns;
