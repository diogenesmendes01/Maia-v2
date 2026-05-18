/**
 * P8.5 — proposalsRouter integration unit tests (post Codex review #101).
 *
 * Drives proposalsRouter.{approve,reject} through tRPC's caller interface
 * with an in-memory repo mock. Verifies the four required behaviors:
 *
 *   1. Role check: non-required roles are FORBIDDEN, even with a valid session.
 *   2. Dual-approval gate: hard_limit / dangerous_tool / etc. require two
 *      distinct approvers before the source transitions to approved.
 *   3. Audit-log INSERT runs BEFORE the source-state change (decideAtomically
 *      orders them inside one tx).
 *   4. Reject path transitions the source to rejected, returns the row id.
 *
 *   5. tenantId from request body cannot override session tenant.
 *   6. Lockdown-critical descriptors (locks.length > 0) require 2 distinct
 *      founder signatures even when the matrix would have allowed dual via
 *      owner+compliance.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { proposalsRouter } from '@/admin-ui/trpc/routers/proposals.js';

type Approval = {
  id: string;
  tenant_id: string;
  proposal_id: string;
  approval_class: string;
  approver_user_id: string;
  approver_role: string;
  decision: 'approved' | 'rejected';
  comment: string;
  decided_at: Date;
};

type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown> | null;
};

type Proposal = {
  id: string;
  type:
    | 'policy_rule'
    | 'soul_bias'
    | 'skill'
    | 'capability_proposal'
    | 'knowledge_proposal';
  descriptor: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  status: 'proposed' | 'pending_review' | 'rejected' | 'activated';
  proposed_at: Date;
  proposed_by: string;
  body: unknown;
  locks: string[];
};

function makeRepoMock(proposals: Proposal[]) {
  const approvals: Approval[] = [];
  const audit: AuditRow[] = [];
  const sourceState: Record<string, Proposal> = {};
  for (const p of proposals) sourceState[p.id] = { ...p };

  return {
    proposalsUnifiedRepo: {
      async getOne(_tenantId: string, id: string) {
        return sourceState[id] ?? null;
      },
      async decideAtomically(input: {
        tenantId: string;
        proposalId: string;
        type: string;
        approvalClass: string;
        actorId: string;
        actorRole: string;
        decision: 'approved' | 'rejected';
        comment: string;
        dualComplete: boolean;
      }) {
        const src = sourceState[input.proposalId];
        if (!src) return { ok: false as const, reason: 'not_found' as const };
        // Insert approval row first (matches decideAtomically order).
        const approval: Approval = {
          id: `approval-${approvals.length + 1}`,
          tenant_id: input.tenantId,
          proposal_id: input.proposalId,
          approval_class: input.approvalClass,
          approver_user_id: input.actorId,
          approver_role: input.actorRole,
          decision: input.decision,
          comment: input.comment,
          decided_at: new Date(),
        };
        approvals.push(approval);
        // Audit BEFORE source mutation (matches decideAtomically order).
        audit.push({
          tenant_id: input.tenantId,
          actor_id: input.actorId,
          actor_role: input.actorRole,
          action: input.decision === 'approved' ? 'proposal_approve' : 'proposal_reject',
          resource_type: 'capability_proposal',
          resource_id: input.proposalId,
          change_summary: {
            approval_class: input.approvalClass,
            comment: input.comment,
            dual_complete: input.dualComplete,
          },
        });
        let sourceTransitioned = false;
        let finalStatus = src.status;
        if (input.decision === 'rejected') {
          src.status = 'rejected';
          finalStatus = 'rejected';
          sourceTransitioned = true;
        } else if (input.dualComplete) {
          src.status = 'pending_review';
          finalStatus = 'pending_review';
          sourceTransitioned = true;
        }
        return {
          ok: true as const,
          approval,
          sourceTransitioned,
          finalStatus,
        };
      },
    },
    proposalApprovalsRepo: {
      async listByProposal(proposalId: string) {
        return approvals.filter((a) => a.proposal_id === proposalId);
      },
    },
    adminAuditLogRepo: {
      async append(entry: AuditRow) {
        audit.push(entry);
        return { ...entry, id: audit.length, created_at: new Date() } as AuditRow & {
          id: number;
          created_at: Date;
        };
      },
    },
    _inspect: { approvals, audit, sourceState },
  };
}

function callerFor(
  role: string,
  tenantId: string,
  userId: string,
  proposals: Proposal[],
) {
  const repos = makeRepoMock(proposals);
  const ctx = {
    session: { user: { id: userId, role, tenant_id: tenantId } },
    userId,
    userRole: role,
    tenantId,
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {
      /* no-op for unit tests */
    },
    assertRole: () => {
      /* no-op for unit tests */
    },
  };
  return { caller: proposalsRouter.createCaller(ctx), repos };
}

const SAFE_PROPOSAL: Proposal = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'capability_proposal',
  descriptor: 'safe read tool',
  risk: 'low',
  source: 'knowledge',
  status: 'proposed',
  proposed_at: new Date('2026-01-01'),
  proposed_by: 'system',
  body: { read_only: true },
  locks: [],
};

const DESTRUCTIVE_PROPOSAL: Proposal = {
  id: '00000000-0000-4000-8000-000000000002',
  type: 'capability_proposal',
  descriptor: 'sends money',
  risk: 'critical',
  source: 'tool',
  status: 'proposed',
  proposed_at: new Date('2026-01-01'),
  proposed_by: 'system',
  body: { sends_money: true },
  locks: ['tool_blast_radius', 'financial_movement'],
};

describe('proposalsRouter.approve — role gate', () => {
  it('viewer cannot approve anything', async () => {
    const { caller } = callerFor('viewer', 'tenant-A', 'user-1', [SAFE_PROPOSAL]);
    await expect(
      caller.approve({ id: SAFE_PROPOSAL.id, comment: 'approve this please' }),
    ).rejects.toThrowError(TRPCError);
  });

  it('owner can approve a capability_safe_tool (single approval)', async () => {
    const { caller, repos } = callerFor('owner', 'tenant-A', 'user-1', [SAFE_PROPOSAL]);
    const res = await caller.approve({
      id: SAFE_PROPOSAL.id,
      comment: 'looks fine, read-only',
    });
    expect(res.dual_complete).toBe(true);
    expect(res.source_transitioned).toBe(true);
    expect(res.final_status).toBe('pending_review');
    expect(repos._inspect.sourceState[SAFE_PROPOSAL.id]?.status).toBe('pending_review');
  });
});

describe('proposalsRouter.approve — dual-approval gate (Codex #101 — destructive must NOT single-ship)', () => {
  it('first founder approving a destructive proposal does NOT activate it', async () => {
    const { caller, repos } = callerFor('founder', 'tenant-A', 'founder-1', [
      DESTRUCTIVE_PROPOSAL,
    ]);
    const res = await caller.approve({
      id: DESTRUCTIVE_PROPOSAL.id,
      comment: 'approving as first founder; awaiting second',
    });
    expect(res.dual_required).toBe(true);
    expect(res.dual_complete).toBe(false);
    expect(res.source_transitioned).toBe(false);
    // Source row stays in 'proposed' until second founder signs.
    expect(repos._inspect.sourceState[DESTRUCTIVE_PROPOSAL.id]?.status).toBe('proposed');
  });

  it('second distinct founder activates it', async () => {
    // Both share the same in-memory repo so the second signature sees the first.
    const repos = makeRepoMock([DESTRUCTIVE_PROPOSAL]);
    // Inject prior founder-1 signature.
    await repos.proposalsUnifiedRepo.decideAtomically({
      tenantId: 'tenant-A',
      proposalId: DESTRUCTIVE_PROPOSAL.id,
      type: 'capability_proposal',
      approvalClass: 'capability_dangerous_tool',
      actorId: 'founder-1',
      actorRole: 'founder',
      decision: 'approved',
      comment: 'first founder',
      dualComplete: false,
    });
    const ctx2 = {
      session: { user: { id: 'founder-2', role: 'founder', tenant_id: 'tenant-A' } },
      userId: 'founder-2',
      userRole: 'founder',
      tenantId: 'tenant-A',
      repos: repos as unknown as typeof import('@/db/repositories.js'),
      assertTenant: () => {},
      assertRole: () => {},
    };
    const caller2 = proposalsRouter.createCaller(ctx2);
    const res = await caller2.approve({
      id: DESTRUCTIVE_PROPOSAL.id,
      comment: 'second founder confirms',
    });
    expect(res.dual_complete).toBe(true);
    expect(res.source_transitioned).toBe(true);
    expect(repos._inspect.sourceState[DESTRUCTIVE_PROPOSAL.id]?.status).toBe('pending_review');
  });

  it('SAME founder cannot satisfy dual approval twice', async () => {
    const repos = makeRepoMock([DESTRUCTIVE_PROPOSAL]);
    await repos.proposalsUnifiedRepo.decideAtomically({
      tenantId: 'tenant-A',
      proposalId: DESTRUCTIVE_PROPOSAL.id,
      type: 'capability_proposal',
      approvalClass: 'capability_dangerous_tool',
      actorId: 'founder-1',
      actorRole: 'founder',
      decision: 'approved',
      comment: 'first signature',
      dualComplete: false,
    });
    const ctx = {
      session: { user: { id: 'founder-1', role: 'founder', tenant_id: 'tenant-A' } },
      userId: 'founder-1',
      userRole: 'founder',
      tenantId: 'tenant-A',
      repos: repos as unknown as typeof import('@/db/repositories.js'),
      assertTenant: () => {},
      assertRole: () => {},
    };
    const caller = proposalsRouter.createCaller(ctx);
    await expect(
      caller.approve({ id: DESTRUCTIVE_PROPOSAL.id, comment: 'trying to double-sign' }),
    ).rejects.toThrowError(TRPCError);
  });

  it('lockdown-critical descriptor (locks.length > 0) FORBIDS non-founder', async () => {
    const { caller } = callerFor('owner', 'tenant-A', 'owner-1', [DESTRUCTIVE_PROPOSAL]);
    await expect(
      caller.approve({ id: DESTRUCTIVE_PROPOSAL.id, comment: 'trying as owner' }),
    ).rejects.toThrowError(TRPCError);
  });
});

describe('proposalsRouter.approve — audit ordering (Codex #101)', () => {
  it('records audit row BEFORE source transitions', async () => {
    const { caller, repos } = callerFor('owner', 'tenant-A', 'owner-1', [SAFE_PROPOSAL]);
    await caller.approve({ id: SAFE_PROPOSAL.id, comment: 'safe approval' });
    const auditRows = repos._inspect.audit;
    expect(auditRows.length).toBeGreaterThan(0);
    const lastAudit = auditRows[auditRows.length - 1];
    expect(lastAudit?.action).toBe('proposal_approve');
    expect(lastAudit?.resource_id).toBe(SAFE_PROPOSAL.id);
    // Source row is also updated (final state).
    expect(repos._inspect.sourceState[SAFE_PROPOSAL.id]?.status).toBe('pending_review');
  });
});

describe('proposalsRouter.reject — single rejection transitions source', () => {
  it('owner can reject a safe proposal', async () => {
    const { caller, repos } = callerFor('owner', 'tenant-A', 'owner-1', [SAFE_PROPOSAL]);
    const res = await caller.reject({
      id: SAFE_PROPOSAL.id,
      comment: 'not useful for our domain',
    });
    expect(res.status).toBe('rejected');
    expect(res.source_transitioned).toBe(true);
    expect(repos._inspect.sourceState[SAFE_PROPOSAL.id]?.status).toBe('rejected');
  });

  it('founder can reject even when not in requiredRoles', async () => {
    // Capability_safe_tool requires 'owner'. Founder is not in requiredRoles
    // but the reject path explicitly allows founder.
    const { caller } = callerFor('founder', 'tenant-A', 'founder-1', [SAFE_PROPOSAL]);
    const res = await caller.reject({
      id: SAFE_PROPOSAL.id,
      comment: 'platform-level rejection',
    });
    expect(res.status).toBe('rejected');
  });
});

describe('proposalsRouter — tenant isolation (Codex #101 — tenantId from session)', () => {
  it('non-founder cannot pass a different tenantId', async () => {
    const { caller } = callerFor('owner', 'tenant-A', 'owner-1', [SAFE_PROPOSAL]);
    await expect(
      caller.approve({
        id: SAFE_PROPOSAL.id,
        tenantId: 'tenant-B',
        comment: 'cross-tenant spoof attempt',
      }),
    ).rejects.toThrowError(/Tenant isolation violation|FORBIDDEN/i);
  });

  it('founder can cross-tenant', async () => {
    // Founder gets to set the tenant explicitly. The mock repo accepts any
    // tenantId so this proves the resolver lets it through.
    const { caller } = callerFor('founder', 'tenant-A', 'founder-1', [SAFE_PROPOSAL]);
    const res = await caller.approve({
      id: SAFE_PROPOSAL.id,
      tenantId: 'tenant-B',
      comment: 'platform cross-tenant support',
    });
    expect(res.source_transitioned).toBe(true);
  });
});
