-- 039: proposal_approvals — tracks dual-approval states across all proposal types
-- (P8.5 Admin UI v1)
--
-- proposals_unified is a virtual UNION view across:
--   * policy_rules
--   * soul_biases
--   * skills
--   * capability_proposals
--   * knowledge_pending_review
-- so this table has no FK to a specific proposal table.
-- Uniqueness is enforced on (proposal_id, approver_role, decision).

CREATE TABLE IF NOT EXISTS proposal_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  proposal_id UUID NOT NULL,
  approval_class TEXT NOT NULL,
  approver_user_id TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, approver_role, decision)
);

CREATE INDEX IF NOT EXISTS proposal_approvals_proposal_id_idx ON proposal_approvals(proposal_id);
CREATE INDEX IF NOT EXISTS proposal_approvals_approval_class_idx ON proposal_approvals(approval_class);
CREATE INDEX IF NOT EXISTS proposal_approvals_tenant_idx ON proposal_approvals(tenant_id);
