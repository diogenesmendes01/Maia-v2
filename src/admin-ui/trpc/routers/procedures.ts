/**
 * Admin UI — procedures read-only router.
 *
 * Read endpoints for /procedures screen:
 *   - listDefinitions   — procedure_definitions by lifecycle status
 *
 * procedureDefinitionsRepo uses applyTenantGuard; we wrap calls accordingly.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const ListDefinitionsInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  status: z
    .enum(['draft', 'proposed', 'active', 'frozen', 'rolled_back'])
    .default('active'),
  limit: z.number().int().min(1).max(200).default(100),
});

export const proceduresRouter = router({
  listDefinitions: protectedProcedure
    .input(ListDefinitionsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.procedureDefinitionsRepo.listByStatus(input.status, input.limit),
      );
      return { items };
    }),
});
