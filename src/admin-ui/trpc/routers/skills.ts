/**
 * Admin UI — Skills Management router (Phase 2: READ ONLY).
 *
 * Read endpoints for the /skills screen, surfacing the `skills` table (P9a
 * Skill Registry) so operators can list/view versioned, tenant/agent-scoped
 * Skill Contracts instead of hand-writing SQL:
 *   - list         — SUMMARY rows for the tenant/agent (no large JSONB), capped,
 *                    plus a `hasMore` truncation signal when the cap is hit
 *   - getById      — the full contract for one skill row
 *   - listVersions — every version of a descriptor in an EXACT scope (newest
 *                    first); the caller passes the selected row's agent_id
 *                    (nullable = tenant-wide) so scopes never mix
 *   - runtimeFlag  — what value of FEATURE_SKILL_REGISTRY_V1 THIS admin-ui
 *                    process sees (drives the "managed here but verify on
 *                    maia-app" banner). NOTE: admin-ui and maia-app are
 *                    separate containers, so this only reflects admin-ui's own
 *                    env — it is NOT maia-app's runtime state.
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

// Server-enforced cap mirrors skillsRepo.SKILLS_LIST_MAX_LIMIT (review PR #209
// finding 2). The router never asks the repo for more than the cap; the repo
// also clamps defensively.
const LIST_LIMIT_CAP = 200;

const ListInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  status: z.enum(['proposed', 'active', 'deprecated', 'rolled_back']).optional(),
  limit: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
});

const GetByIdInput = z.object({
  id: z.string(),
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const ListVersionsInput = z.object({
  descriptor: z.string(),
  tenantId: z.string().optional(),
  // The agent scope of the SELECTED row (review PR #209 finding 3). Pass the
  // row's own agent_id — null for a tenant-wide skill — so version history is
  // scope-exact and never blends agent-scoped + tenant-wide rows that happen
  // to share a descriptor. This is the runWithTenantContext agent too.
  agentId: z.string().nullable(),
});

export const skillsRouter = router({
  /**
   * SUMMARY rows for the tenant/agent, optionally filtered by status, capped at
   * LIST_LIMIT_CAP (review PR #209 finding 2). Returns only the table columns
   * (no large JSONB) — the full contract is fetched per-row via getById.
   *
   * Review PR #209 finding A: also returns `hasMore` so the UI can warn when the
   * result was truncated at the cap instead of silently dropping skills. The
   * repo fetches limit+1 rows to compute this cheaply (no full cursor
   * pagination — out of scope at this volume); narrow the filter (agent/status)
   * to see the rest.
   */
  list: protectedProcedure.input(ListInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const limit = Math.min(input.limit ?? LIST_LIMIT_CAP, LIST_LIMIT_CAP);
    const { items, hasMore } = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.skillsRepo.listSummariesPage(input.status, limit),
    );
    return { items, hasMore };
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

  /**
   * Every version of a descriptor in an EXACT scope, newest first (review PR
   * #209 finding 3). The caller passes the selected row's agentId (null =
   * tenant-wide); we both scope the repo query to it AND use it as the context
   * agent so agent-scoped and tenant-wide rows that share a descriptor never
   * mix. For a tenant-wide row the context agent is unused by the scope filter
   * (it matches agent_id IS NULL), so a placeholder context agent is fine.
   */
  listVersions: protectedProcedure
    .input(ListVersionsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const contextAgent = input.agentId ?? '__tenant_wide__';
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: contextAgent },
        async () => ctx.repos.skillsRepo.listVersions(input.descriptor, input.agentId),
      );
      return { items };
    }),

  /**
   * runtimeFlag — review PR #209 finding 1.
   *
   * Returns the value of FEATURE_SKILL_REGISTRY_V1 as seen by THIS admin-ui
   * process's own env config. admin-ui and maia-app run in separate containers
   * with independent env, so this CANNOT report maia-app's runtime state — it
   * only tells operators what this admin-ui is configured with. The flag gates
   * skill *execution* on maia-app (SkillRunner gate 1), not data management
   * here; the page banner makes the "verify on maia-app" caveat explicit.
   *
   * `adminUiSkillRegistryEnabled` is the honest, source-scoped field name.
   */
  runtimeFlag: protectedProcedure.query(() => {
    return { adminUiSkillRegistryEnabled: config.FEATURE_SKILL_REGISTRY_V1 };
  }),
});
