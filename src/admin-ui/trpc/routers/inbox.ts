/**
 * P8.5 — Tela 1 (Proposal Inbox) router.
 *
 * Procedures:
 *   - listProposals       — paginated UNION across proposal sources
 *   - counters            — count by type for top-of-page badges
 *   - bulkReject          — reject N risk=low proposals in one tx (writes audit)
 *
 * Post-Codex-review #101: tenantId is derived from the authenticated session
 * (ctx.tenantId). The optional `input.tenantId` is a sanity-check value only —
 * any mismatch with the session value is FORBIDDEN. See resolveTenantId.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import {
  ProposalTypeSchema,
  RiskLevelSchema,
  ProposalUnifiedStatusSchema,
} from '../types.js';

const ListInputSchema = z.object({
  tenantId: z.string().optional(),
  types: z.array(ProposalTypeSchema).optional(),
  risks: z.array(RiskLevelSchema).optional(),
  sources: z.array(z.string()).optional(),
  status: ProposalUnifiedStatusSchema.default('proposed'),
  ageBucket: z.enum(['lt_1h', 'lt_24h', 'lt_7d', 'lt_30d', 'older']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});

const CountersInputSchema = z.object({ tenantId: z.string().optional() });

const BulkRejectInputSchema = z.object({
  tenantId: z.string().optional(),
  ids: z.array(z.string().uuid()).min(1).max(50),
  comment: z.string().min(10).max(1000),
});

export const inboxRouter = router({
  listProposals: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      return await ctx.repos.proposalsUnifiedRepo.list({
        tenantId,
        types: input.types,
        risks: input.risks,
        sources: input.sources,
        status: input.status,
        ageBucket: input.ageBucket,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),

  counters: protectedProcedure
    .input(CountersInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      return await ctx.repos.proposalsUnifiedRepo.countersByType(tenantId);
    }),

  bulkReject: protectedProcedure
    .input(BulkRejectInputSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'founder');

      const result = await ctx.repos.proposalsUnifiedRepo.bulkReject(
        tenantId,
        input.ids,
        ctx.userId,
        ctx.userRole,
        input.comment,
      );

      if (result.rejected_count === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No proposals were eligible for bulk reject (risk=low + no architecture lock)',
        });
      }

      return result;
    }),
});
