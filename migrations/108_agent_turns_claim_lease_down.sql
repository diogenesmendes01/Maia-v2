-- Rollback da 108 (issue #504).
--
-- NÃO destrutivo para o turno: `claimed_by`, `claim_token` e
-- `lease_expires_at` pertencem à 097 e permanecem. O down remove apenas o que
-- a 108 acrescentou — a prova de vida (`heartbeat_at`) e as duas constraints.
--
-- Pré-condição operacional: nenhum processo com `FEATURE_TURN_CLAIM=true`
-- rodando. Com a coluna ausente o repositório de claim falha ALTO (erro de
-- coluna inexistente) em vez de degradar em silêncio — o que é o
-- comportamento desejado, mas derruba o ingresso se feito com o runtime novo
-- no ar. Sequência segura: desligar a flag em todas as réplicas, aguardar as
-- leases vigentes expirarem (TURN_LEASE_TTL_MS), então rodar este down.
--
-- Após o down, turnos que estavam `claimed`/`running` com lease continuam com
-- o trio preenchido e voltam a ser recuperáveis por `lease_expires_at <= now()`
-- exatamente como a 097 previa: nenhum turno fica preso.
--
-- Constraints primeiro, coluna depois: dropar a coluna não invalida as
-- constraints (elas não a referenciam), mas a ordem explícita mantém o down
-- legível e o diagnóstico de falha parcial trivial.

ALTER TABLE agent_turns
  DROP CONSTRAINT IF EXISTS agent_turns_claimed_by_len_chk;

ALTER TABLE agent_turns
  DROP CONSTRAINT IF EXISTS agent_turns_claim_trio_chk;

ALTER TABLE agent_turns
  DROP COLUMN IF EXISTS heartbeat_at;
