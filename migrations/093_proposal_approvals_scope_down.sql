-- 093 down — restaura a unicidade global e remove colunas/índices de escopo.
DROP INDEX IF EXISTS proposal_approvals_scope_read_idx;
DROP INDEX IF EXISTS proposal_approvals_legacy_uq;
DROP INDEX IF EXISTS proposal_approvals_scoped_uq;
ALTER TABLE proposal_approvals
  DROP CONSTRAINT IF EXISTS proposal_approvals_scope_pair_chk;
ALTER TABLE proposal_approvals
  DROP CONSTRAINT IF EXISTS proposal_approvals_source_chk;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposal_approvals_proposal_user_decision_uq'
  ) THEN
    ALTER TABLE proposal_approvals
      ADD CONSTRAINT proposal_approvals_proposal_user_decision_uq
      UNIQUE (proposal_id, approver_user_id, decision);
  END IF;
END $$;
ALTER TABLE proposal_approvals DROP COLUMN IF EXISTS proposal_source;
ALTER TABLE proposal_approvals DROP COLUMN IF EXISTS agent_id;
