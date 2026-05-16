/**
 * P8.5 — Tela 3 (Version History & Rollback) router.
 *
 * Procedures:
 *   - listVersions      — list versions per source-of-truth (sotKind)
 *   - getInUseBy        — show which agents/conversations use a given version
 *   - rollback          — switch active version to an earlier one (audit)
 *
 * Currently surfaces `agent_operational_profile_versions` (P4 — already in main).
 * Future SoTs (policy_rules, soul_biases, skills) added once their schemas land.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { validateRollbackTarget } from '../../lib/rollback-targets.js';

const SotKindSchema = z.enum([
  'agent_operational_profile_versions',
  'policy_rules',
  'soul_biases',
  'skills',
]);

const ListInputSchema = z.object({
  tenantId: z.string(),
  sotKind: SotKindSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const GetInUseBySchema = z.object({
  tenantId: z.string(),
  sotKind: SotKindSchema,
  sotId: z.string(),
});

const RollbackInputSchema = z.object({
  tenantId: z.string(),
  sotKind: SotKindSchema,
  sotId: z.string(),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  reason: z.string().min(10).max(2000),
});

export const versionsRouter = router({
  listVersions: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      // Stub: returns empty array; real implementation joins per sotKind.
      // For agent_operational_profile_versions, list all versions ordered by version desc.
      return { items: [] as Array<{
        id: string;
        sot_kind: string;
        sot_id: string;
        version: number;
        status: string;
        created_at: Date;
      }> };
    }),

  getInUseBy: protectedProcedure
    .input(GetInUseBySchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      // Stub: returns empty list; full implementation joins agent assignments + active conversations.
      return { in_use_by: [] as string[] };
    }),

  rollback: protectedProcedure
    .input(RollbackInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'founder');

      if (!validateRollbackTarget(input.sotKind, input.fromVersion, input.toVersion)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid rollback target (must be earlier than current version)',
        });
      }

      // Audit trail
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: input.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'version_rollback',
        resource_type: input.sotKind,
        resource_id: input.sotId,
        change_summary: {
          from_version: input.fromVersion,
          to_version: input.toVersion,
          reason: input.reason,
        },
      });

      // Stub: actual rollback logic deferred to per-SoT repo (P4 already supports
      // operational_profile rollback; pattern extends to policy/soul/skill).
      return {
        status: 'rolled_back',
        from_version: input.fromVersion,
        to_version: input.toVersion,
      };
    }),
});
