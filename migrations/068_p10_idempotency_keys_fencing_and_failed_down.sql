-- Rollback de 065: remove reservation_token + restaura o CHECK de estado/
-- coerência da migration 064 (vocabulário {in_progress, completed} apenas).
--
-- ATENÇÃO: se houver linhas com `state = 'failed'`, este DOWN vai falhar ao
-- reaplicar o CHECK de 064 (que só aceita in_progress/completed). É
-- comportamento esperado — significa que existem reservas terminais
-- marcadas como falha. O operador precisa decidir o destino delas antes de
-- reverter:
--
--   1. Deletar reservas falhas (descarta o registro de falha):
--        DELETE FROM idempotency_keys WHERE state = 'failed';
--   2. OU promover/expirar conforme a política de retry da aplicação.
--
-- Pre-flight check seguro:
--   SELECT COUNT(*) FROM idempotency_keys WHERE state = 'failed';
--   Zero linhas = seguro rodar. Linhas > 0 = resolver primeiro.
--
-- Atomicidade: `_down.sql` é rodado manualmente via `psql -f` — embrulhamos
-- em BEGIN/COMMIT pra que uma falha intermediária não deixe a tabela sem
-- CHECK e sem a coluna.

BEGIN;

DROP INDEX IF EXISTS idx_idempotency_keys_failed_created;

-- Restaura o CHECK de coerência da 064 (sem o ramo 'failed').
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_coherence_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_coherence_check
  CHECK (
    (state = 'completed' AND resultado IS NOT NULL AND expires_at IS NULL)
    OR
    (state = 'in_progress' AND resultado IS NULL AND expires_at IS NOT NULL)
  );

-- Restaura o CHECK de vocabulário da 064 (sem 'failed').
ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_check
  CHECK (state IN ('in_progress', 'completed'));

ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS reservation_token;

COMMIT;
