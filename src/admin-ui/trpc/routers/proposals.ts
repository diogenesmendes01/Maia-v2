/**
 * P8.5 — Tela 2 (Proposal Diff & Approval) router.
 *
 * Procedures:
 *   - getProposal       — full proposal detail + body + lock metadata
 *   - approve           — record approval; mutates source-of-truth on activate
 *   - reject            — record rejection + transitions source row to rejected
 *
 * Post-Codex-review #101:
 *   1. Both approve + reject now go through proposalsUnifiedRepo.decideAtomically,
 *      which validates source status, records the approval, appends audit, and
 *      mutates the source-of-truth row inside a single transaction.
 *   2. tenantId is ALWAYS taken from the authenticated session (ctx.tenantId).
 *      The `input.tenantId` field is accepted only as a sanity-check value and
 *      MUST equal the session tenant; ctx.assertTenant enforces this.
 *   3. Architecture-lock proposals (locks.length > 0) require role=founder.
 *      hard_limit / soul_core / dangerous_tool / drift_correction additionally
 *      require dual approval. Both rules enforced before INSERT.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import {
  getApprovalClassFor,
  requiresDualApproval,
  requiredRolesFor,
  architectureLocksFor,
} from '../../lib/approval-matrix.js';

const GetInputSchema = z.object({
  id: z.string().uuid(),
  /** Optional sanity-check; if present MUST equal ctx.tenantId. */
  tenantId: z.string().optional(),
});

const ApproveInputSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().optional(),
  comment: z.string().min(10).max(2000),
});

const RejectInputSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().optional(),
  comment: z.string().min(10).max(2000),
});

export const proposalsRouter = router({
  getProposal: protectedProcedure
    .input(GetInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(tenantId, input.id);
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
        architecture_locks: architectureLocksFor(approvalClass).concat(
          proposal.locks.filter((l) => !architectureLocksFor(approvalClass).includes(l)),
        ),
      };
    }),

  approve: protectedProcedure
    .input(ApproveInputSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(tenantId, input.id);
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }

      const approvalClass = getApprovalClassFor(proposal.type, proposal.risk);
      const requiredRoles = requiredRolesFor(approvalClass);
      const matrixLocks = architectureLocksFor(approvalClass);
      const allLocks = [...matrixLocks, ...proposal.locks.filter((l) => !matrixLocks.includes(l))];
      const dualRequired = requiresDualApproval(approvalClass) || allLocks.length > 0;

      // Role gate. Founder is always allowed (super-role); other roles must
      // appear in the approval class's requiredRoles list.
      if (ctx.userRole !== 'founder' && !requiredRoles.includes(ctx.userRole)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Role ${ctx.userRole} cannot approve ${approvalClass} proposals`,
        });
      }

      // Architecture-lock guard: ONLY founder may sign on any architecture-lock
      // descriptor. Post-Codex-review #101: this combined with dualRequired
      // (computed above) ensures 2 distinct founder signatures are needed
      // before sourceTransition can fire on a locked proposal.
      if (allLocks.length > 0 && ctx.userRole !== 'founder') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Architecture-lock proposals require founder role',
        });
      }

      // Round-2 fix: pass gateParams into decideAtomically so the dup-check
      // and willSatisfyGate recomputation happen INSIDE the transaction, after
      // locking the source row. The pre-flight dup checks below are kept as a
      // fast-fail UX shortcut (avoids acquiring the DB lock for obvious
      // duplicates) but the authoritative check is transactional.
      const existingFastCheck = await ctx.repos.proposalApprovalsRepo.listByProposal(input.id);

      // Fast-fail: same user cannot record two approval rows.
      if (existingFastCheck.some((a) => a.approver_user_id === ctx.userId && a.decision === 'approved')) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You have already approved this proposal',
        });
      }

      // Fast-fail: same role cannot double-sign non-lockdown dual classes.
      if (dualRequired && allLocks.length === 0) {
        if (existingFastCheck.some((a) => a.approver_role === ctx.userRole && a.decision === 'approved')) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Role ${ctx.userRole} already approved this proposal`,
          });
        }
      }

      // Optimistic pre-check (non-authoritative — real check is inside the tx).
      let willSatisfyGate: boolean;
      if (allLocks.length > 0) {
        const priorFounderIds = new Set(
          existingFastCheck
            .filter((a) => a.decision === 'approved' && a.approver_role === 'founder')
            .map((a) => a.approver_user_id),
        );
        priorFounderIds.add(ctx.userId);
        willSatisfyGate = priorFounderIds.size >= 2;
      } else if (dualRequired) {
        const approvedRoles = new Set(
          existingFastCheck.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
        );
        approvedRoles.add(ctx.userRole);
        willSatisfyGate = requiredRoles.every((r) => approvedRoles.has(r));
      } else {
        willSatisfyGate = true;
      }

      // Atomic decision: insert approval + audit + source transition.
      // gateParams causes decideAtomically to re-check dup + recompute gate
      // from the locked approval list, preventing concurrent-approval races.
      const result = await ctx.repos.proposalsUnifiedRepo.decideAtomically({
        tenantId,
        proposalId: input.id,
        type: proposal.type,
        approvalClass,
        actorId: ctx.userId,
        actorRole: ctx.userRole,
        decision: 'approved',
        comment: input.comment,
        dualComplete: willSatisfyGate,
        gateParams: {
          dualRequired,
          requiredRoles,
          allLocks,
        },
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
        }
        if (result.reason === 'invalid_source_status') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Proposal source has already transitioned; refresh and retry',
          });
        }
        if (result.reason === 'source_not_supported') {
          throw new TRPCError({
            code: 'NOT_IMPLEMENTED',
            message: 'Approval for this proposal source is not implemented yet',
          });
        }
        // round-2: transactional dup-check inside decideAtomically.
        if (result.reason === 'already_approved_by_user') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'You have already approved this proposal (concurrent request detected)',
          });
        }
        if (result.reason === 'already_approved_by_role') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Role ${ctx.userRole} already approved this proposal (concurrent request detected)`,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Source transition failed: ${result.reason}`,
        });
      }

      // Use the authoritative dualComplete from inside the transaction.
      const txDualComplete = result.dualComplete;

      const approvedRoles = new Set(
        [...existingFastCheck, result.approval]
          .filter((a) => a.decision === 'approved')
          .map((a) => a.approver_role),
      );
      const remainingRoles = requiredRoles.filter((r) => !approvedRoles.has(r));

      return {
        status: result.sourceTransitioned && txDualComplete ? 'activated' : 'pending_dual_approval',
        approval_id: result.approval.id,
        dual_required: dualRequired,
        dual_complete: txDualComplete,
        source_transitioned: result.sourceTransitioned,
        final_status: result.finalStatus,
        remaining_roles: remainingRoles,
      };
    }),

  reject: protectedProcedure
    .input(RejectInputSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const proposal = await ctx.repos.proposalsUnifiedRepo.getOne(tenantId, input.id);
      if (!proposal) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
      }

      const approvalClass = getApprovalClassFor(proposal.type, proposal.risk);
      const requiredRoles = requiredRolesFor(approvalClass);

      // Reject gate: required role OR founder (founder always allowed to reject).
      if (!requiredRoles.includes(ctx.userRole) && ctx.userRole !== 'founder') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Role ${ctx.userRole} cannot reject ${approvalClass} proposals`,
        });
      }

      const result = await ctx.repos.proposalsUnifiedRepo.decideAtomically({
        tenantId,
        proposalId: input.id,
        type: proposal.type,
        approvalClass,
        actorId: ctx.userId,
        actorRole: ctx.userRole,
        decision: 'rejected',
        comment: input.comment,
        dualComplete: true, // single-rejection is enough; no dual-reject gate.
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal not found' });
        }
        if (result.reason === 'invalid_source_status') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Proposal source has already transitioned; refresh and retry',
          });
        }
        if (result.reason === 'source_not_supported') {
          throw new TRPCError({
            code: 'NOT_IMPLEMENTED',
            message: 'Rejection for this proposal source is not implemented yet',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Source transition failed: ${result.reason}`,
        });
      }

      return {
        status: 'rejected',
        approval_id: result.approval.id,
        source_transitioned: result.sourceTransitioned,
        final_status: result.finalStatus,
      };
    }),
});
