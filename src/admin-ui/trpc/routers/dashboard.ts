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
      for (const agent of activeAgents) {
        const channels = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: agent.id },
          async () => ctx.repos.channelsRepo.listActive(),
        );
        activeChannelsTotal += channels.length;
      }

      // Unresolved drift alerts — open across all agents in this tenant. The
      // drift router already exposes a per-agent feed; here we just want the
      // total. We reuse the agentDriftAlertsRepo.listOpen helper if available;
      // fallback to 0 if not yet wired.
      let driftOpenTotal = 0;
      const repo = (ctx.repos as unknown as {
        agentDriftAlertsRepo?: {
          countOpenForTenant?: (tenantId: string) => Promise<number>;
        };
      }).agentDriftAlertsRepo;
      if (repo?.countOpenForTenant) {
        driftOpenTotal = await repo.countOpenForTenant(tenantId);
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
