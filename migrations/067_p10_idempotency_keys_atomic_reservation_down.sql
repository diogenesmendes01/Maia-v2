-- Rollback de 064: remove state/expires_at + CHECKs + partial index e
-- restaura `resultado NOT NULL`.
--
-- ATENÇÃO: se houver linhas com `state = 'in_progress'`, este DOWN vai
-- falhar quando tentar reaplicar `resultado NOT NULL` (essas linhas têm
-- resultado=NULL por design). É comportamento esperado — significa que
-- existem reservas pendentes que nunca completaram. O operador precisa:
--
--   1. Deletar reservas órfãs / pendentes:
--        DELETE FROM idempotency_keys
--         WHERE state = 'in_progress';
--   2. OU esperar o cleanup worker rodar (sweep de in_progress expirados).
--   3. SE o cleanup também tiver sido revertido, garantir que toda
--      escrita para a tabela cessou antes de rodar este down.
--
-- Pre-flight check seguro:
--   SELECT COUNT(*) FROM idempotency_keys
--    WHERE state = 'in_progress' OR resultado IS NULL;
--   Zero linhas = seguro rodar. Linhas > 0 = resolver primeiro.
--
-- Atomicidade: `_down.sql` é rodado manualmente via `psql -f` — embrulhamos
-- em BEGIN/COMMIT pra que uma falha intermediária não deixe a tabela em
-- estado parcial (sem CHECK e sem NOT NULL).

BEGIN;

DROP INDEX IF EXISTS idx_idempotency_keys_in_progress_expires;

ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_coherence_check;

ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_state_check;

-- Reaplica resultado NOT NULL. Vai falhar se houver linhas com resultado
-- IS NULL — ver checklist no topo do arquivo.
ALTER TABLE idempotency_keys
  ALTER COLUMN resultado SET NOT NULL;

ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS expires_at;

ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS state;

COMMIT;
