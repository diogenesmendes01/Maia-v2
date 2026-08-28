-- Reversão da 137 (issue #513, fatia A).
--
-- Derrubar a coluna apaga o histórico de `session_fencing_token` por linha. É
-- aceitável APENAS porque o rollback pressupõe a volta à topologia de processo
-- único (`MAIA_PROCESS_ROLE=all`, uma réplica), onde não há segundo dono para
-- um token antigo enganar. A ordem do runbook é derrubar os session owners
-- distribuídos PRIMEIRO — reverter isto com duas réplicas no ar reabre
-- exatamente a janela de split-brain que a migration fecha.
--
-- `session_owner_instance` e `session_owner_lease_expires_at` NÃO são tocadas:
-- são da 103 e continuam servindo ao endereçamento de comandos.

BEGIN;

DROP INDEX IF EXISTS channel_line_state_session_orfa_idx;

ALTER TABLE channel_line_state
  DROP CONSTRAINT IF EXISTS channel_line_state_session_fence_chk;

ALTER TABLE channel_line_state
  DROP COLUMN IF EXISTS session_fencing_token;

COMMIT;
