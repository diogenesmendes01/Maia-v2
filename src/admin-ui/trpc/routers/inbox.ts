/**
 * P8.5 — Tela 1 (Proposal Inbox) router.
 *
 * Procedures:
 *   - listProposals       — paginated UNION across proposal sources
 *   - counters            — count by type for top-of-page badges
 *   - bulkReject          — reject N risk=low proposals in one tx (writes audit)
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import {
  ProposalTypeSchema,
  RiskLevelSchema,
  ProposalUnifiedStatusSchema,
} from '../types.js';

const ListInputSchema = z.object({
  tenantId: z.string(),
  types: z.array(ProposalTypeSchema).optional(),
  risks: z.array(RiskLevelSchema).optional(),
  sources: z.array(z.string()).optional(),
  status: ProposalUnifiedStatusSchema.default('proposed'),
  ageBucket: z.enum(['lt_1h', 'lt_24h', 'lt_7d', 'lt_30d', 'older']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});

const CountersInputSchema = z.object({ tenantId: z.string() });

const BulkRejectInputSchema = z.object({
  tenantId: z.string(),
  ids: z.array(z.string().uuid()).min(1).max(50),
  comment: z.string().min(10).max(1000),
});

export const inboxRouter = router({
  listProposals: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      return await ctx.repos.proposalsUnifiedRepo.list({
        tenantId: input.tenantId,
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
      ctx.assertTenant(input.tenantId);
      return await ctx.repos.proposalsUnifiedRepo.countersByType(input.tenantId);
    }),

  bulkReject: protectedProcedure
    .input(BulkRejectInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'founder');

      const result = await ctx.repos.proposalsUnifiedRepo.bulkReject(
        input.tenantId,
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
