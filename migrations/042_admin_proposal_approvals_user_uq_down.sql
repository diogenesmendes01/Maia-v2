-- 042 down: restore the original UNIQUE (proposal_id, approver_role, decision)
-- constraint on proposal_approvals.
--
-- WARNING: this breaks dual-founder approval flows for lockdown-critical
-- descriptors. The down-migration exists only for symmetry; do not run on a
-- live admin-ui v1 deployment.

ALTER TABLE proposal_approvals
  DROP CONSTRAINT IF EXISTS proposal_approvals_proposal_user_decision_uq;

ALTER TABLE proposal_approvals
  ADD CONSTRAINT proposal_approvals_proposal_role_decision_uq
  UNIQUE (proposal_id, approver_role, decision);
