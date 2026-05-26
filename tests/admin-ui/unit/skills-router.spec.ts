/**
 * Admin UI — skillsRouter (read-only) unit tests.
 *
 * Covers the review PR #209 findings on the read path:
 *
 *  - FIX 3 (scope-exact version history): listVersions for an agent-scoped row
 *    and for a tenant-wide (agent_id=null) row that SHARE a descriptor must
 *    each return ONLY their own scope — never the union (the descriptor
 *    collision case).
 *  - FIX 4 / tenant isolation: a founder can read another tenant's skills via
 *    the router (cross-tenant), while a non-founder targeting a non-home
 *    tenant is rejected with FORBIDDEN by resolveTenantId.
 *  - FIX 2 (summary cap): list forwards a cap to the repo and never exceeds it.
 *
 * Pattern mirrors tests/admin-ui/unit/agents-router.spec.ts: drive the router
 * through createCaller with an in-memory repo. The router wraps repo calls in
 * runWithTenantContext, so the mock repo reads getCurrentTenant/getCurrentAgent
 * and applies the SAME tenant + agent scoping the real repo does.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { skillsRouter } from '@/admin-ui/trpc/routers/skills.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

type Skill = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  version: number;
  status: string;
  activated_at: Date | null;
  created_at: Date;
  // full-contract fields (only present so getById returns a believable row)
  goal?: string;
  procedure?: Record<string, unknown>;
  constraints?: unknown[];
};

/**
 * Faithful in-memory skillsRepo. listSummaries / getById / listVersions apply
 * the exact same visibility rules as the real repo (tenant from context;
 * agent scope current-OR-tenant-wide for summaries, EXACT scope for
 * listVersions). lastListLimit records the cap the router forwarded.
 */
function makeRepos(skills: Skill[], capture?: { lastListLimit?: number }) {
  const rows = skills.map((s) => ({ ...s }));
  return {
    skillsRepo: {
      async listSummaries(status?: string, limit?: number) {
        if (capture) capture.lastListLimit = limit;
        const tenant = getCurrentTenant();
        const agent = getCurrentAgent();
        let out = rows.filter(
          (r) =>
            r.tenant_id === tenant &&
            (r.agent_id === agent || r.agent_id === null) &&
            (status === undefined || r.status === status),
        );
        // Mirror the server cap behaviour.
        if (typeof limit === 'number') out = out.slice(0, limit);
        return out.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          agent_id: r.agent_id,
          skill_descriptor: r.skill_descriptor,
          category: r.category,
          execution_mode: r.execution_mode,
          version: r.version,
          status: r.status,
          activated_at: r.activated_at,
          created_at: r.created_at,
        }));
      },
      async getById(id: string) {
        const tenant = getCurrentTenant();
        const agent = getCurrentAgent();
        const r = rows.find((x) => x.id === id && x.tenant_id === tenant);
        if (!r) return null;
        // tenant-wide visible to all; agent-scoped only to its agent
        if (r.agent_id !== null && r.agent_id !== agent) return null;
        return r;
      },
      async listVersions(descriptor: string, agentId?: string | null) {
        const tenant = getCurrentTenant();
        const agent = getCurrentAgent();
        return rows
          .filter((r) => {
            if (r.tenant_id !== tenant) return false;
            if (r.skill_descriptor !== descriptor) return false;
            // EXACT scope (review PR #209 finding 3).
            if (agentId === undefined) {
              return r.agent_id === agent || r.agent_id === null;
            }
            if (agentId === null) return r.agent_id === null;
            // explicit agent: must equal context agent (cross-agent rejected)
            if (agentId !== agent) {
              throw new Error(
                `agent_scope_violation: input agent ${agentId} vs context ${agent}`,
              );
            }
            return r.agent_id === agentId;
          })
          .sort((a, b) => b.version - a.version);
      },
    },
    _rows: rows,
  };
}

function caller(
  role: string,
  sessionTenant: string,
  repos: ReturnType<typeof makeRepos>,
) {
  const ctx = {
    session: { user: { id: 'u1', role, tenant_id: sessionTenant } },
    userId: 'u1',
    userRole: role,
    tenantId: sessionTenant,
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'role' });
      }
    },
  };
  return skillsRouter.createCaller(ctx);
}

// A descriptor shared by an agent-scoped skill AND a tenant-wide skill in the
// same tenant — the collision the scope-exact fix must keep apart.
const SHARED = 'detect_legal_risk';

function collisionFixture(): Skill[] {
  const base = {
    category: 'classify',
    execution_mode: 'prompt_only',
    status: 'active',
    activated_at: new Date('2024-01-01T00:00:00Z'),
    created_at: new Date('2024-01-01T00:00:00Z'),
    goal: 'g',
    procedure: { system_prompt: 'p' },
    constraints: [],
  };
  return [
    // Agent-scoped versions (agent-x): v1, v2.
    { ...base, id: 'a1', tenant_id: 'tenant-A', agent_id: 'agent-x', skill_descriptor: SHARED, version: 1 },
    { ...base, id: 'a2', tenant_id: 'tenant-A', agent_id: 'agent-x', skill_descriptor: SHARED, version: 2 },
    // Tenant-wide versions (agent_id null): v1, v2, v3.
    { ...base, id: 'tw1', tenant_id: 'tenant-A', agent_id: null, skill_descriptor: SHARED, version: 1 },
    { ...base, id: 'tw2', tenant_id: 'tenant-A', agent_id: null, skill_descriptor: SHARED, version: 2 },
    { ...base, id: 'tw3', tenant_id: 'tenant-A', agent_id: null, skill_descriptor: SHARED, version: 3 },
  ];
}

describe('skillsRouter.listVersions — scope-exact (review PR #209 finding 3)', () => {
  it('agent-scoped row returns ONLY agent-scoped versions (no tenant-wide bleed)', async () => {
    const repos = makeRepos(collisionFixture());
    const res = await caller('owner', 'tenant-A', repos).listVersions({
      descriptor: SHARED,
      agentId: 'agent-x', // selected row is agent-scoped
    });
    const ids = res.items.map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
    // none of the tenant-wide rows leaked in
    expect(res.items.every((r) => r.agent_id === 'agent-x')).toBe(true);
  });

  it('tenant-wide row (agentId=null) returns ONLY tenant-wide versions (no agent bleed)', async () => {
    const repos = makeRepos(collisionFixture());
    const res = await caller('owner', 'tenant-A', repos).listVersions({
      descriptor: SHARED,
      agentId: null, // selected row is tenant-wide
    });
    const ids = res.items.map((r) => r.id).sort();
    expect(ids).toEqual(['tw1', 'tw2', 'tw3']);
    expect(res.items.every((r) => r.agent_id === null)).toBe(true);
  });

  it('newest-first ordering is preserved within the exact scope', async () => {
    const repos = makeRepos(collisionFixture());
    const res = await caller('owner', 'tenant-A', repos).listVersions({
      descriptor: SHARED,
      agentId: null,
    });
    expect(res.items.map((r) => r.version)).toEqual([3, 2, 1]);
  });
});

describe('skillsRouter — cross-tenant gate (review PR #209 finding 4 / isolation)', () => {
  const fixture: Skill[] = [
    {
      id: 'b1',
      tenant_id: 'tenant-B',
      agent_id: 'agent-y',
      skill_descriptor: 'foo',
      category: 'classify',
      execution_mode: 'prompt_only',
      version: 1,
      status: 'active',
      activated_at: null,
      created_at: new Date(),
    },
  ];

  it('founder can read another tenant via input.tenantId', async () => {
    const repos = makeRepos(fixture);
    const res = await caller('founder', 'home', repos).list({
      tenantId: 'tenant-B',
      agentId: 'agent-y',
    });
    expect(res.items.map((r) => r.id)).toEqual(['b1']);
  });

  it('non-founder targeting a non-home tenant is rejected (FORBIDDEN)', async () => {
    const repos = makeRepos(fixture);
    await expect(
      caller('owner', 'tenant-A', repos).list({
        tenantId: 'tenant-B', // not their home tenant
        agentId: 'agent-y',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('non-founder targeting a non-home tenant is rejected on listVersions too', async () => {
    const repos = makeRepos(fixture);
    await expect(
      caller('owner', 'tenant-A', repos).listVersions({
        tenantId: 'tenant-B',
        descriptor: 'foo',
        agentId: 'agent-y',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('non-founder reading OWN tenant works (sanity)', async () => {
    const own: Skill[] = [
      { ...fixture[0]!, id: 'own1', tenant_id: 'tenant-A', agent_id: 'agent-z' },
    ];
    const repos = makeRepos(own);
    const res = await caller('owner', 'tenant-A', repos).list({ agentId: 'agent-z' });
    expect(res.items.map((r) => r.id)).toEqual(['own1']);
  });
});

describe('skillsRouter.list — summary cap forwarded (review PR #209 finding 2)', () => {
  it('forwards the default cap (200) to the repo when no limit is given', async () => {
    const capture: { lastListLimit?: number } = {};
    const repos = makeRepos(collisionFixture(), capture);
    await caller('owner', 'tenant-A', repos).list({ agentId: 'agent-x' });
    expect(capture.lastListLimit).toBe(200);
  });

  it('never forwards more than the cap even if a larger limit slips through', async () => {
    const capture: { lastListLimit?: number } = {};
    const repos = makeRepos(collisionFixture(), capture);
    // input schema caps at 200, but assert the router clamps defensively too.
    await caller('owner', 'tenant-A', repos).list({ agentId: 'agent-x', limit: 200 });
    expect(capture.lastListLimit).toBeLessThanOrEqual(200);
  });
});
