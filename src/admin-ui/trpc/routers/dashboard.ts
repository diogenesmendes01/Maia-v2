/**
 * Admin UI — dashboard summary router.
 *
 * One procedure (`summary`) that returns aggregated counts to populate the
 * top-of-page metric cards on the `/dashboard` screen.
 *
 * Counts surfaced:
 *   - proposals pending review (per type)
 *   - drift alerts unresolved (total)
 *   - active agents in this tenant
 *   - active channels in this tenant (sum across agents)
 *
 * Wherever a repo helper needs (tenant, agent) context (via applyTenantGuard),
 * we wrap with runWithTenantContext so the read works inside a tRPC procedure
 * that has no implicit AsyncLocalStorage.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const SummaryInputSchema = z.object({ tenantId: z.string().optional() });

export const dashboardRouter = router({
  summary: protectedProcedure
    .input(SummaryInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const proposalsByType = await ctx.repos.proposalsUnifiedRepo.countersByType(tenantId);

      const agents = await ctx.repos.agentsRepo.listByTenant(tenantId);
      const activeAgents = agents.filter((a) => a.status === 'active');

      let activeChannelsTotal = 0;
      let driftOpenTotal = 0;
      for (const agent of activeAgents) {
        const [channels, drifts] = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: agent.id },
          async () =>
            Promise.all([
              ctx.repos.channelsRepo.listActive(),
              // driftAlertsRepo.listUnresolved is scoped to (tenant, agent)
              // by applyTenantGuard, so the fan-out across agents gives us
              // the tenant-wide unresolved total. Codex review #162: the
              // previous code called a non-existent agentDriftAlertsRepo and
              // always returned 0.
              ctx.repos.driftAlertsRepo.listUnresolved(),
            ]),
        );
        activeChannelsTotal += channels.length;
        driftOpenTotal += drifts.length;
      }

      const proposalsTotal = Object.values(proposalsByType).reduce<number>(
        (sum, n) => sum + (typeof n === 'number' ? n : 0),
        0,
      );

      return {
        proposals: {
          total: proposalsTotal,
          by_type: proposalsByType,
        },
        agents: {
          total: agents.length,
          active: activeAgents.length,
        },
        channels: {
          active: activeChannelsTotal,
        },
        drift_alerts: {
          open: driftOpenTotal,
        },
      };
    }),
});
