-- Down: rollback PR #87 closed-loop test gate.
-- NOTE: rows com status='testing' ou 'reverted' DEVEM ser tratadas antes
-- de aplicar o rollback (CHECK rejeitará). Idem para colunas adicionais.

ALTER TABLE capability_proposals DROP COLUMN IF EXISTS revert_reason;
ALTER TABLE capability_proposals DROP COLUMN IF EXISTS reverted_at;
ALTER TABLE capability_proposals DROP COLUMN IF EXISTS last_test_at;
ALTER TABLE capability_proposals DROP COLUMN IF EXISTS last_test_outcome;

ALTER TABLE capability_proposals DROP CONSTRAINT IF EXISTS capability_proposals_status_check;

ALTER TABLE capability_proposals ADD CONSTRAINT capability_proposals_status_check
  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'delivered'));
