/**
 * Admin UI — Skills Management router (Phase 2: READ ONLY).
 *
 * Read endpoints for the /skills screen, surfacing the `skills` table (P9a
 * Skill Registry) so operators can list/view versioned, tenant/agent-scoped
 * Skill Contracts instead of hand-writing SQL:
 *   - list         — skills for the tenant/agent, optionally by status
 *   - getById      — the full contract for one skill row
 *   - listVersions — every version of a descriptor (newest first)
 *   - runtimeFlag  — whether FEATURE_SKILL_REGISTRY_V1 is enabled on maia-app
 *                    (drives the "managed here but won't execute" banner)
 *
 * Phase 3 will add the propose/activate/deprecate/rollback mutations + audit.
 *
 * Tenant scoping mirrors capabilities.ts: tenant is resolved from the session
 * via resolveTenantId (founders may target any tenant; everyone else is pinned
 * to their own), and every repo call runs inside runWithTenantContext so the
 * repo's tenant + agent guards apply. Any authenticated role may read.
 */
import { z } from 'zod';
import { config } from '@/config/env.js';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const ListInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  status: z.enum(['proposed', 'active', 'deprecated', 'rolled_back']).optional(),
});

const GetByIdInput = z.object({
  id: z.string(),
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const ListVersionsInput = z.object({
  descriptor: z.string(),
  tenantId: z.string().optional(),
  agentId: z.string(),
});

export const skillsRouter = router({
  /** All skills for the tenant/agent, optionally filtered by status. */
  list: protectedProcedure.input(ListInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.skillsRepo.listAll(input.status),
    );
    return { items };
  }),

  /** The full contract for a single skill row (or null when not visible). */
  getById: protectedProcedure.input(GetByIdInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const item = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.skillsRepo.getById(input.id),
    );
    return { item };
  }),

  /** Every version of a descriptor, newest first. */
  listVersions: protectedProcedure
    .input(ListVersionsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.skillsRepo.listVersions(input.descriptor),
      );
      return { items };
    }),

  /**
   * runtimeFlag — exposes FEATURE_SKILL_REGISTRY_V1 (read server-side from the
   * env config) so the page can warn that skills are managed here but won't
   * actually execute on maia-app until the flag is enabled. The flag gates
   * skill *execution* (SkillRunner gate 1), not data management.
   */
  runtimeFlag: protectedProcedure.query(() => {
    return { skillRegistryEnabled: config.FEATURE_SKILL_REGISTRY_V1 };
  }),
});
