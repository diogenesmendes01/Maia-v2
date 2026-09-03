-- Rollback da 138 (issue #469, fatia A do work loop).
--
-- Ordem: constraints e índice primeiro, colunas depois. Dropar as colunas já
-- derrubaria os dois em cascata, mas explicitar mantém o `_down` legível como
-- o inverso exato do `_up`.
--
-- ATENÇÃO OPERACIONAL: sem `claim_token` o `transitionTask` volta a escrever
-- sem fencing e sem prazo, e uma tarefa claimada por um worker que morra
-- volta a ficar presa em `running` para sempre — que é exatamente o defeito
-- que a 138 conserta. Antes de rodar isto:
--
--   1. desligue o grupo `console` em `MAIA_SCHEDULER_GROUPS` (ele já nasce
--      desligado; confira que não foi ligado);
--   2. confirme que nenhuma tarefa está em `running`:
--        SELECT count(*) FROM objective_tasks WHERE status = 'running';
--   3. só então rode este arquivo.
--
-- O rollback NÃO devolve para `pending` as tarefas em `running`: o `_down` de
-- um esquema não deve tomar decisão de negócio sobre trabalho em voo. O passo
-- 2 acima é a checagem que substitui isso, e é humana de propósito.

DROP INDEX IF EXISTS objective_tasks_lease_expiry_idx;

ALTER TABLE objective_tasks
  DROP CONSTRAINT IF EXISTS objective_tasks_claim_coherence_chk;

ALTER TABLE objective_tasks
  DROP CONSTRAINT IF EXISTS objective_tasks_claim_attempts_chk;

ALTER TABLE objective_tasks
  DROP COLUMN IF EXISTS claim_attempts,
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS claimed_by;
