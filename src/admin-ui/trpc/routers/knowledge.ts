/**
 * Admin UI — knowledge read-only router.
 *
 * Read endpoints for /knowledge screen. Knowledge in Maia is split across
 * three concrete sources:
 *   - memory_entry  — sensitivity-tagged conversational memory
 *   - agent_facts   — declarative facts with lifecycle
 *   - learned_rules — inferred behavioral rules by tipo
 *
 * Procedures:
 *   - listMemoryNeedsReview  — memory_entry rows where needs_review=true
 *   - listFacts              — facts within a set of scopes (default: agent-wide)
 *   - listRules              — learned_rules per tipo (default: behavior_pattern)
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

const ListMemoryInput = TenantAgentInput.extend({
  limit: z.number().int().min(1).max(500).default(100),
});

const ListFactsInput = TenantAgentInput.extend({
  scopes: z.array(z.string()).min(1).default(['agent']),
});

const ListRulesInput = TenantAgentInput.extend({
  tipo: z.string().default('behavior_pattern'),
});

export const knowledgeRouter = router({
  listMemoryNeedsReview: protectedProcedure
    .input(ListMemoryInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.memoryEntryRepo.listNeedsReview(input.limit),
      );
      return { items };
    }),

  listFacts: protectedProcedure.input(ListFactsInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.factsRepo.listForScopes(input.scopes),
    );
    return { items };
  }),

  listRules: protectedProcedure.input(ListRulesInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.rulesRepo.listActive(input.tipo),
    );
    return { items };
  }),
});
