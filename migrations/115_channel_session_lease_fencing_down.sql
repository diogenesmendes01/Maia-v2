-- 115 down — remove o fencing da posse de sessão (issue #513 §6).
--
-- Reverter volta ao contrato da 103: a posse continua REGISTRADA
-- (`session_owner_instance` + lease) e o endereçamento de `stop_line`/`repair`
-- segue funcionando; o que se perde é a EXCLUSIVIDADE verificável — sem o
-- token, duas réplicas `session-owner` voltam a poder abrir a mesma linha.
--
-- Por isso o rollback só é seguro com UMA réplica de session-owner no ar
-- (`MAIA_PROCESS_ROLE=all`, ou o compose de papel único). O runbook
-- `docs/runbooks/line-ownership-duplicates.md` §6 descreve a ordem: escalar
-- session-owner para 1, confirmar posse única, então reverter.
--
-- Índices primeiro, constraints depois, colunas por último: dropar as colunas
-- cascatearia de qualquer forma, mas a ordem explícita deixa uma falha parcial
-- legível.

DROP INDEX IF EXISTS channel_line_state_session_lease_expiry_idx;
DROP INDEX IF EXISTS channel_line_state_session_owner_idx;

ALTER TABLE channel_line_state
  DROP CONSTRAINT IF EXISTS channel_line_state_session_owner_complete_chk;
ALTER TABLE channel_line_state
  DROP CONSTRAINT IF EXISTS channel_line_state_session_fence_chk;

ALTER TABLE channel_line_state
  DROP COLUMN IF EXISTS session_owner_acquired_at,
  DROP COLUMN IF EXISTS session_fencing_token;
