/**
 * P8.5 — Tela 3 (Version History & Rollback) router.
 *
 * Procedures:
 *   - listVersions      — list versions per source-of-truth (sotKind)
 *   - getInUseBy        — show which agents/conversations use a given version
 *   - rollback          — switch active version to an earlier one
 *
 * Post-Codex-review #101:
 *   - rollback NO LONGER returns status='rolled_back' for unwired SoTs. It now
 *     throws NOT_IMPLEMENTED so the operator gets an explicit recovery-failed
 *     signal during an incident instead of a false-positive.
 *   - The audit row is still appended on every attempt (success OR failure)
 *     so forensics can see who attempted what, when.
 *   - tenantId derived from session.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { validateRollbackTarget } from '../../lib/rollback-targets.js';

const SotKindSchema = z.enum([
  'agent_operational_profile_versions',
  'policy_rules',
  'soul_biases',
  'skills',
]);

const ListInputSchema = z.object({
  tenantId: z.string().optional(),
  sotKind: SotKindSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const GetInUseBySchema = z.object({
  tenantId: z.string().optional(),
  sotKind: SotKindSchema,
  sotId: z.string(),
});

const RollbackInputSchema = z.object({
  tenantId: z.string().optional(),
  sotKind: SotKindSchema,
  sotId: z.string(),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  reason: z.string().min(10).max(2000),
});

/**
 * Wired source-of-truth kinds that have a rollback implementation. Until one
 * lands the per-SoT entry must throw NOT_IMPLEMENTED to avoid false-positive
 * incident recovery signals.
 */
const ROLLBACK_IMPLEMENTED: Record<string, boolean> = {
  agent_operational_profile_versions: false, // P4 repo doesn't expose admin-ui rollback yet
  policy_rules: false,
  soul_biases: false,
  skills: false,
};

export const versionsRouter = router({
  listVersions: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      const _tenantId = resolveTenantId(ctx, input.tenantId);
      // Stub: returns empty array; real implementation joins per sotKind.
      // For agent_operational_profile_versions, list all versions ordered by version desc.
      return {
        items: [] as Array<{
          id: string;
          sot_kind: string;
          sot_id: string;
          version: number;
          status: string;
          created_at: Date;
        }>,
        not_implemented: true as const,
      };
    }),

  getInUseBy: protectedProcedure
    .input(GetInUseBySchema)
    .query(async ({ input, ctx }) => {
      const _tenantId = resolveTenantId(ctx, input.tenantId);
      // Stub: full implementation joins agent assignments + active conversations.
      return { in_use_by: [] as string[], not_implemented: true as const };
    }),

  rollback: protectedProcedure
    .input(RollbackInputSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'founder');

      if (!validateRollbackTarget(input.sotKind, input.fromVersion, input.toVersion)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid rollback target (must be earlier than current version)',
        });
      }

      // Always audit the ATTEMPT — operators can see who tried what, even if
      // the SoT isn't wired yet.
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'version_rollback_attempt',
        resource_type: input.sotKind,
        resource_id: input.sotId,
        change_summary: {
          from_version: input.fromVersion,
          to_version: input.toVersion,
          reason: input.reason,
          implemented: ROLLBACK_IMPLEMENTED[input.sotKind] ?? false,
        },
      });

      // Post-Codex-review #101: NEVER return 'rolled_back' without actually
      // mutating the source. Throw NOT_IMPLEMENTED so the operator's incident
      // playbook fails loudly instead of silently miring on stale state.
      if (!ROLLBACK_IMPLEMENTED[input.sotKind]) {
        throw new TRPCError({
          code: 'NOT_IMPLEMENTED',
          message:
            `Rollback for ${input.sotKind} is not implemented in admin-ui v1. ` +
            `Use the per-SoT repo directly or contact the platform team. ` +
            `Attempt has been logged to admin_audit_log.`,
        });
      }

      // Future per-SoT branches go here. Each MUST:
      //   1. Mutate the active-pointer in a transaction.
      //   2. Verify the active version actually changed (SELECT after UPDATE).
      //   3. Re-audit with action='version_rollback_completed' inside the same tx.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `BUG: ROLLBACK_IMPLEMENTED says ${input.sotKind} is wired but no branch handles it`,
      });
    }),
});
