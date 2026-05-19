/**
 * P8.5 — internal audit-log router (read-only).
 *
 * Procedures:
 *   - listAuditEntries     — paginated list for audit forensics
 *
 * IMPORTANT: there is NO mutation endpoint here. All `append` calls happen
 * inline inside other mutation procedures (proposals.approve, versions.rollback,
 * etc.) to keep the audit + mutation in a single transaction. This router is
 * read-only.
 *
 * Post-Codex-review #101: tenantId derived from authenticated session.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';

const ListAuditSchema = z.object({
  tenantId: z.string().optional(),
  actorId: z.string().optional(),
  resourceType: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const auditRouter = router({
  listAuditEntries: protectedProcedure
    .input(ListAuditSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await ctx.repos.adminAuditLogRepo.list({
        tenantId,
        actorId: input.actorId,
        resourceType: input.resourceType,
        limit: input.limit,
      });
      return { items };
    }),
});
