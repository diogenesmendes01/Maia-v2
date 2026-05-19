/**
 * P8.5 — dual approval state machine tests.
 */
import { describe, it, expect } from 'vitest';
import {
  computeApprovalState,
  applyApproval,
  type ApprovalRecord,
} from '@/admin-ui/lib/dual-approval-state.js';

const mkApproval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approver_user_id: 'user-a',
  approver_role: 'owner',
  decision: 'approved',
  comment: 'looks good',
  decided_at: new Date('2026-05-15T10:00:00Z'),
  ...overrides,
});

describe('computeApprovalState — single approval (non-dual)', () => {
  it('pending → fully_approved on first owner approval (soft class)', () => {
    const state = computeApprovalState('prop-1', 'policy_rule_soft_guidance', []);
    expect(state.status).toBe('pending');
    expect(state.remaining_roles).toEqual(['owner']);

    const next = applyApproval(state, mkApproval());
    expect(next.status).toBe('fully_approved');
    expect(next.remaining_roles).toEqual([]);
  });
});

describe('computeApprovalState — dual approval', () => {
  it('starts pending → partial after first → fully_approved after second', () => {
    const state = computeApprovalState('prop-2', 'policy_rule_hard_limit', []);
    expect(state.status).toBe('pending');
    expect(state.remaining_roles).toEqual(['owner', 'compliance_officer']);

    const afterOwner = applyApproval(state, mkApproval({ approver_role: 'owner' }));
    expect(afterOwner.status).toBe('partial');
    expect(afterOwner.remaining_roles).toEqual(['compliance_officer']);

    const afterBoth = applyApproval(
      afterOwner,
      mkApproval({ approver_role: 'compliance_officer', approver_user_id: 'user-b' }),
    );
    expect(afterBoth.status).toBe('fully_approved');
    expect(afterBoth.remaining_roles).toEqual([]);
  });

  it('throws when same role tries to approve twice', () => {
    const state = computeApprovalState('prop-3', 'policy_rule_hard_limit', []);
    const afterOwner = applyApproval(state, mkApproval({ approver_role: 'owner' }));
    expect(() => applyApproval(afterOwner, mkApproval({ approver_role: 'owner' }))).toThrow(
      /already recorded/,
    );
  });

  it('enforces distinct-approver invariant: same user cannot fill both slots', () => {
    const state = computeApprovalState('prop-4', 'soul_bias_core_value', []);
    const afterOwner = applyApproval(state, mkApproval({ approver_user_id: 'user-a', approver_role: 'owner' }));
    expect(() =>
      applyApproval(
        afterOwner,
        mkApproval({ approver_user_id: 'user-a', approver_role: 'compliance_officer' }),
      ),
    ).toThrow(/distinct approvers/);
  });
});

describe('computeApprovalState — rejection terminal', () => {
  it('any rejection → status=rejected', () => {
    const state = computeApprovalState('prop-5', 'policy_rule_hard_limit', [
      mkApproval({ decision: 'rejected', comment: 'no thanks' }),
    ]);
    expect(state.status).toBe('rejected');
  });
});
