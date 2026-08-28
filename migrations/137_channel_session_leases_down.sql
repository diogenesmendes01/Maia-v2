-- Reversão da 137 (issue #513, fatia A).
--
-- Derrubar a tabela derruba junto o histórico de `fencing_token` por canal. É
-- aceitável APENAS porque o rollback pressupõe a volta à topologia de processo
-- único (`MAIA_PROCESS_ROLE=all`, uma réplica), onde não há segundo dono para
-- um token antigo enganar. Reverter esta migration com duas réplicas de
-- session owner no ar é o cenário que a issue chama de "voltar ao send direto
-- quebrando a idempotência": a ordem do runbook é derrubar os owners
-- distribuídos PRIMEIRO.
--
-- `DROP TABLE` já remove os índices e a FK; declarar cada um seria ruído.

BEGIN;

DROP TABLE IF EXISTS channel_session_leases;

COMMIT;
