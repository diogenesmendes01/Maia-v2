/**
 * P8.5 — Dual approval state machine.
 *
 * Models a proposal's approval state as it moves from
 *   pending → owner_approved → fully_approved (or → rejected at any step).
 *
 * State transitions:
 *   pending          + owner.approve         → owner_approved
 *   pending          + compliance.approve    → compliance_approved
 *   owner_approved   + compliance.approve    → fully_approved (activate)
 *   compliance_approved + owner.approve      → fully_approved (activate)
 *   any              + reject                → rejected (cancel)
 *
 * Invariants:
 *   - distinct approvers required for `requires_distinct=true` classes
 *   - same role cannot approve twice
 */
import { requiredRolesFor, requiresDualApproval } from './approval-matrix.js';
import type { ApprovalClassId } from '../../db/schema.js';

export type DualApprovalStatus =
  | 'pending'
  | 'partial'
  | 'fully_approved'
  | 'rejected';

export interface ApprovalRecord {
  approver_user_id: string;
  approver_role: string;
  decision: 'approved' | 'rejected';
  comment: string;
  decided_at: Date;
}

export interface DualApprovalState {
  proposal_id: string;
  approval_class: ApprovalClassId;
  required_roles: string[];
  approvals: ApprovalRecord[];
  status: DualApprovalStatus;
  remaining_roles: string[];
}

export function computeApprovalState(
  proposal_id: string,
  approval_class: ApprovalClassId,
  approvals: ApprovalRecord[],
): DualApprovalState {
  const required_roles = requiredRolesFor(approval_class);
  const dual = requiresDualApproval(approval_class);

  const rejected = approvals.find((a) => a.decision === 'rejected');
  if (rejected) {
    return {
      proposal_id,
      approval_class,
      required_roles,
      approvals,
      status: 'rejected',
      remaining_roles: [],
    };
  }

  const approved_roles = new Set(
    approvals.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
  );
  const remaining = required_roles.filter((r) => !approved_roles.has(r));

  let status: DualApprovalStatus;
  if (approved_roles.size === 0) {
    status = 'pending';
  } else if (dual && remaining.length > 0) {
    status = 'partial';
  } else if (!dual && approved_roles.size >= 1) {
    status = 'fully_approved';
  } else {
    // dual && remaining.length === 0
    status = 'fully_approved';
  }

  return {
    proposal_id,
    approval_class,
    required_roles,
    approvals,
    status,
    remaining_roles: remaining,
  };
}

/**
 * Apply a new approval and return the updated state.
 *
 * Throws if:
 *   - same role already has a decision
 *   - dual approval but same user_id tries to fulfill second slot
 */
export function applyApproval(
  state: DualApprovalState,
  newApproval: ApprovalRecord,
): DualApprovalState {
  // Same role already decided?
  if (
    state.approvals.some(
      (a) => a.approver_role === newApproval.approver_role && a.decision === newApproval.decision,
    )
  ) {
    throw new Error(`Role ${newApproval.approver_role} already recorded ${newApproval.decision}`);
  }

  // Distinct approver invariant for dual classes
  if (requiresDualApproval(state.approval_class)) {
    if (
      newApproval.decision === 'approved' &&
      state.approvals.some(
        (a) => a.approver_user_id === newApproval.approver_user_id && a.decision === 'approved',
      )
    ) {
      throw new Error('Dual approval requires distinct approvers');
    }
  }

  const updated = [...state.approvals, newApproval];
  return computeApprovalState(state.proposal_id, state.approval_class, updated);
}
