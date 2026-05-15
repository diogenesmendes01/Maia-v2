-- P5 (PR #87 fix): closed-loop test gate.
-- 1) expand status CHECK constraint para incluir 'testing' (intermediate state
--    entre approved e delivered, durante runCapabilityTests) e 'reverted'
--    (terminal alt para failed tests pós-ativação).
-- 2) add last_test_outcome / last_test_at colunas para dashboard queries não
--    precisarem JOIN com capability_test_results (Superpowers Important #2).
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE capability_proposals DROP CONSTRAINT IF EXISTS capability_proposals_status_check;

ALTER TABLE capability_proposals ADD CONSTRAINT capability_proposals_status_check
  CHECK (status IN ('draft', 'submitted', 'approved', 'testing', 'delivered', 'rejected', 'reverted'));

ALTER TABLE capability_proposals
  ADD COLUMN IF NOT EXISTS last_test_outcome TEXT
    CHECK (last_test_outcome IS NULL OR last_test_outcome IN ('pass', 'fail', 'error'));

ALTER TABLE capability_proposals
  ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ;

ALTER TABLE capability_proposals
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;

ALTER TABLE capability_proposals
  ADD COLUMN IF NOT EXISTS revert_reason TEXT;
