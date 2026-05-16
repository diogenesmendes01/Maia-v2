/**
 * P8.5 — Tela 2 (Proposal Diff & Approval) router.
 *
 * Procedures:
 *   - getProposal       — full proposal detail + body + lock metadata
 *   - approve           — record approval; activates if dual-approval complete
 *   - reject            — record rejection with comment
 *
 * Dual-approval: hard_limit / soul_core / dangerous_tool / drift_correction
 * require both `owner` and `compliance_officer`. The activation transition
 * happens only when both rows exist with decision=approved.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { getApprovalClassFor, requiresDualApproval, requiredRolesFor } from '../../lib/approval-matrix.js';

const GetInputSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
});

const ApproveInputSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  comment: z.string().min(10).max(2000),
});

const RejectInputSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  comment: z.string().min(10).max(2000),
});

export const proposalsRouter = router({
  getProposal: protectedProcedure
    .input(GetInputSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(input.tenantId, input.id);
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }
      const approvals = await ctx.repos.proposalApprovalsRepo.listByProposal(input.id);
      const approvalClass = getApprovalClassFor(proposal.type, proposal.risk);
      return {
        ...proposal,
        approvals,
        approval_class: approvalClass,
        required_roles: requiredRolesFor(approvalClass),
        requires_dual: requiresDualApproval(approvalClass),
      };
    }),

  approve: protectedProcedure
    .input(ApproveInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);

      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(input.tenantId, input.id);
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }

      const approvalClass = getApprovalClassFor(proposal.type, proposal.risk);
      const requiredRoles = requiredRolesFor(approvalClass);

      if (!requiredRoles.includes(ctx.userRole)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Role ${ctx.userRole} cannot approve ${approvalClass} proposals`,
        });
      }

      // Architecture lock guard: founder-only
      if (proposal.locks.length > 0 && ctx.userRole !== 'founder') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Architecture-lock proposals require founder role',
        });
      }

      // Idempotency: if same role already recorded a decision, reject duplicate
      const existing = await ctx.repos.proposalApprovalsRepo.listByProposal(input.id);
      if (existing.some((a) => a.approver_role === ctx.userRole && a.decision === 'approved')) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Role ${ctx.userRole} already approved this proposal`,
        });
      }

      // Distinct-approver check for dual approval (same user can't sign twice
      // even if they hold multiple roles).
      if (requiresDualApproval(approvalClass)) {
        if (existing.some((a) => a.approver_user_id === ctx.userId && a.decision === 'approved')) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Dual approval requires distinct approvers',
          });
        }
      }

      const approval = await ctx.repos.proposalApprovalsRepo.record({
        tenant_id: input.tenantId,
        proposal_id: input.id,
        approval_class: approvalClass,
        approver_user_id: ctx.userId,
        approver_role: ctx.userRole,
        decision: 'approved',
        comment: input.comment,
      });

      // Determine if this approval completes the activation gate
      const allApprovals = [...existing, approval];
      const distinctApproved = new Set(
        allApprovals.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
      );
      const dualReady = requiresDualApproval(approvalClass)
        ? requiredRoles.every((r) => distinctApproved.has(r))
        : distinctApproved.size >= 1;

      // Audit log
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: input.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'proposal_approve',
        resource_type: proposal.type,
        resource_id: input.id,
        change_summary: {
          approval_class: approvalClass,
          comment: input.comment,
          dual_required: requiresDualApproval(approvalClass),
          dual_complete: dualReady,
        },
      });

      return {
        status: dualReady ? 'activated' : 'pending_dual_approval',
        approval_id: approval.id,
        dual_required: requiresDualApproval(approvalClass),
        dual_complete: dualReady,
        remaining_roles: requiredRoles.filter((r) => !distinctApproved.has(r)),
      };
    }),

  reject: protectedProcedure
    .input(RejectInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);

      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(input.tenantId, input.id);
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }

      const approvalClass = getApprovalClassFor(proposal.type, proposal.risk);
      const requiredRoles = requiredRolesFor(approvalClass);

      if (!requiredRoles.includes(ctx.userRole) && ctx.userRole !== 'founder') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Role ${ctx.userRole} cannot reject ${approvalClass} proposals`,
        });
      }

      const approval = await ctx.repos.proposalApprovalsRepo.record({
        tenant_id: input.tenantId,
        proposal_id: input.id,
        approval_class: approvalClass,
        approver_user_id: ctx.userId,
        approver_role: ctx.userRole,
        decision: 'rejected',
        comment: input.comment,
      });

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: input.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'proposal_reject',
        resource_type: proposal.type,
        resource_id: input.id,
        change_summary: { approval_class: approvalClass, comment: input.comment },
      });

      return { status: 'rejected', approval_id: approval.id };
    }),
});
