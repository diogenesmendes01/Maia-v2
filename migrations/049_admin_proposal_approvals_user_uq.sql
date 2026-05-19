-- 049: proposal_approvals — fix UNIQUE constraint to include approver_user_id
-- (post Codex review #101)
--
-- The original UNIQUE (proposal_id, approver_role, decision) blocked dual
-- founder approval flows: when two distinct founders both need to sign on a
-- lockdown-critical descriptor, the second INSERT would conflict on
-- (proposal_id='X', approver_role='founder', decision='approved').
--
-- Replace with UNIQUE (proposal_id, approver_user_id, decision) so the
-- invariant "same user can't sign twice" is enforced at the DB level while
-- the dual-founder path still works. Distinct-role logic stays in the app
-- layer (proposalsRouter.approve).

ALTER TABLE proposal_approvals
  DROP CONSTRAINT IF EXISTS proposal_approvals_proposal_role_decision_uq,
  DROP CONSTRAINT IF EXISTS proposal_approvals_proposal_id_approver_role_decision_key;

-- Re-add with the corrected column set.
ALTER TABLE proposal_approvals
  ADD CONSTRAINT proposal_approvals_proposal_user_decision_uq
  UNIQUE (proposal_id, approver_user_id, decision);
