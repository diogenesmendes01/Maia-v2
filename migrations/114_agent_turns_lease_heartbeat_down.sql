-- Rollback da 114 (issue #504).
--
-- Ordem: índice primeiro, coluna depois — dropar a coluna já derrubaria o
-- índice em cascata, mas explicitar mantém o `_down` legível como o inverso
-- exato do `_up` e não depende do comportamento implícito do Postgres.
--
-- ATENÇÃO OPERACIONAL: derrubar `heartbeat_at` apaga a única evidência de
-- "quando o dono deu sinal de vida". Antes de rodar isto, PARE o consumo
-- (`pauseQueueWorkers`) e confirme que nenhum turno está em `claimed`/`running`
-- com lease viva — ver docs/runbooks/turn-state-machine.md §5. O claim em si
-- não quebra sem a coluna (o UPDATE deixa de escrevê-la), mas o diagnóstico
-- de lease fica cego.

DROP INDEX IF EXISTS agent_turns_lease_expiry_idx;

ALTER TABLE agent_turns
  DROP COLUMN IF EXISTS heartbeat_at;
