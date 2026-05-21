/**
 * Admin UI — capabilities read-only router.
 *
 * Read endpoints for /capabilities screen:
 *   - listDomains       — all capability domains for the tenant
 *   - listSkills        — all capability skills (filtered by domain optional)
 *   - listGaps          — gaps per level (low|mentionable|proposed)
 *   - listProposals     — capability_proposals (per admin-ui status)
 *
 * All repos use applyTenantGuard, so calls are wrapped with runWithTenantContext.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const TenantAgentInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const ListProposalsInput = TenantAgentInput.extend({
  status: z
    .enum(['draft', 'submitted', 'approved', 'rejected', 'delivered'])
    .default('submitted'),
});

const ListGapsInput = TenantAgentInput.extend({
  levels: z
    .array(z.enum(['silent', 'dashboard', 'mentionable', 'proposed']))
    .default(['proposed', 'mentionable']),
});

export const capabilitiesRouter = router({
  listDomains: protectedProcedure.input(TenantAgentInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.capabilitiesDomainRepo.listAll(),
    );
    return { items };
  }),

  listSkills: protectedProcedure.input(TenantAgentInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.capabilitiesSkillRepo.listAll(),
    );
    return { items };
  }),

  listGaps: protectedProcedure.input(ListGapsInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.capabilityGapsRepo.listByLevels(input.levels),
    );
    return { items };
  }),

  listProposals: protectedProcedure
    .input(ListProposalsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.capabilityProposalsRepo.listByStatus(input.status),
      );
      return { items };
    }),
});
