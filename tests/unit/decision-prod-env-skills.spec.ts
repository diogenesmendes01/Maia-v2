/**
 * SkillsRepoAdapter (prod-env.ts) — Codex PR #215 review fixes.
 *
 * Covers two findings:
 *   BLOCKER 2 (tenant isolation): findActive/find MUST scope the P9a lookups to
 *     the ROUTED agent carried in the query, NOT the ambient context agent. If
 *     channel policy routes to agent A while the BaseContextPacket was built for
 *     agent B, selection must use A's skills and never leak B's.
 *   CORRECTNESS 4 (category coverage): the adapter must enumerate EVERY DB skill
 *     category (classify/extract/compose/decide/tool_mediated/diagnose/plan/
 *     evaluator) so all active skills become candidates — not just the original
 *     respond/tool_mediated/decide/plan subset.
 *
 * Mocking strategy: keep `@/db/tenant-context.js` REAL so the adapter's nested
 * runWithTenantContext genuinely flows through AsyncLocalStorage and the mocked
 * P9a repo can observe the scoped agent via getCurrentAgent(). Mock the DB
 * client + P9a skillsRepo only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, getCurrentAgent } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockListByCategory, mockGetById } = vi.hoisted(() => ({
  mockListByCategory: vi.fn(),
  mockGetById: vi.fn(),
}));

vi.mock('@/db/client.js', async () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  db: {},
  pool: {},
  isDbConnected: () => true,
  probeDb: async () => true,
  shutdownDb: async () => {},
}));

vi.mock('@/control-plane/skill-registry/skills-repo.js', () => ({
  skillsRepo: {
    listByCategory: mockListByCategory,
    getById: mockGetById,
  },
  SKILLS_LIST_MAX_LIMIT: 200,
}));

// Import the adapter factory AFTER mocks are registered.
import { createProductionDecisionEngineEnv } from '@/runtime/decision/prod-env.js';

function mkRow(overrides: { id: string; skill_descriptor: string; category: string }) {
  return {
    id: overrides.id,
    skill_descriptor: overrides.skill_descriptor,
    category: overrides.category,
    status: 'active',
    when_to_use: '',
    allowed_tools: [],
    policy_descriptors: [],
    runtime_hints: {},
    version: 1,
  };
}

describe('SkillsRepoAdapter — Codex PR #215 review', () => {
  let adapter: ReturnType<typeof createProductionDecisionEngineEnv>['skillsRepo'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockListByCategory.mockResolvedValue([]);
    mockGetById.mockResolvedValue(null);
    adapter = createProductionDecisionEngineEnv().skillsRepo;
  });

  // -------------------------------------------------------------------------
  // BLOCKER 2 — routed agent A while context agent is B ⇒ scope to A.
  // -------------------------------------------------------------------------
  it('BLOCKER 2 — findActive scopes P9a lookups to the ROUTED agent, never the context agent', async () => {
    const observedAgents: string[] = [];
    mockListByCategory.mockImplementation(async () => {
      // P9a reads the ambient agent from tenant-context; capture what the
      // adapter pinned for this call.
      observedAgents.push(getCurrentAgent());
      return [];
    });

    // Context agent is B; the DE query routes to agent A.
    await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B-context' },
      () =>
        adapter.findActive({
          tenant_id: 'tenant-1',
          agent_id: 'agent-A-routed',
          applicable_to_intent: 'greet',
        }),
    );

    expect(observedAgents.length).toBeGreaterThan(0);
    // Every P9a lookup must have run under the routed agent A...
    for (const a of observedAgents) {
      expect(a).toBe('agent-A-routed');
    }
    // ...and NEVER the context agent B (tenant-isolation invariant).
    expect(observedAgents).not.toContain('agent-B-context');
  });

  it('BLOCKER 2 — find() scopes getById to the supplied routed scope, not the context agent', async () => {
    let observedAgent: string | undefined;
    mockGetById.mockImplementation(async () => {
      observedAgent = getCurrentAgent();
      return null;
    });

    await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B-context' },
      () =>
        adapter.find('skill-xyz', {
          tenant_id: 'tenant-1',
          agent_id: 'agent-A-routed',
        }),
    );

    expect(observedAgent).toBe('agent-A-routed');
  });

  // -------------------------------------------------------------------------
  // CORRECTNESS 4 — every DB category is enumerated.
  // -------------------------------------------------------------------------
  it('CORRECTNESS 4 — enumerates all 8 DB skill categories (incl. classify/extract/compose/diagnose/evaluator)', async () => {
    await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-A' },
      () =>
        adapter.findActive({
          tenant_id: 'tenant-1',
          agent_id: 'agent-A',
        }),
    );

    const queried = mockListByCategory.mock.calls.map((c) => c[0]);
    for (const cat of [
      'classify',
      'extract',
      'compose',
      'decide',
      'tool_mediated',
      'diagnose',
      'plan',
      'evaluator',
    ]) {
      expect(queried).toContain(cat);
    }
  });

  it('CORRECTNESS 4 — a skill in a previously-excluded category becomes a candidate', async () => {
    // Before the fix, a `classify` skill was never enumerated → never a
    // candidate. Now it surfaces.
    mockListByCategory.mockImplementation(async (cat: string) => {
      if (cat === 'classify') {
        return [mkRow({ id: 's_classify', skill_descriptor: 'intent.classify', category: 'classify' })];
      }
      return [];
    });

    const skills = await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-A' },
      () => adapter.findActive({ tenant_id: 'tenant-1', agent_id: 'agent-A' }),
    );

    expect(skills.map((s) => s.id)).toContain('s_classify');
  });

  // -------------------------------------------------------------------------
  // Codex PR #217 review — agent-isolation DEPTH.
  // The tests above prove the adapter OBSERVES the routed agent; these prove,
  // with SEEDED per-owner rows (not just context observation), that an agent's
  // OWNED skills never surface under another agent — while tenant-wide
  // (agent_id = null) skills are shared BY DESIGN. Also covers find()/getById
  // (item 5) and concurrent in-flight requests (item 6).
  // -------------------------------------------------------------------------
  function seededStore() {
    return [
      { ...mkRow({ id: 's_A', skill_descriptor: 'a.skill', category: 'tool_mediated' }), agent_id: 'agent-A' },
      { ...mkRow({ id: 's_B', skill_descriptor: 'b.skill', category: 'tool_mediated' }), agent_id: 'agent-B' },
      { ...mkRow({ id: 's_shared', skill_descriptor: 'shared.skill', category: 'tool_mediated' }), agent_id: null },
    ];
  }

  it('items 3+4 — agent-owned skills never leak across agents; tenant-wide (null owner) skills ARE shared', async () => {
    const store = seededStore();
    // Reproduce P9a listByCategory's scope filter so this is a REAL non-leak
    // assertion, not just "the adapter observed agent A".
    mockListByCategory.mockImplementation(async (cat: string) => {
      const ctxAgent = getCurrentAgent();
      return store.filter(
        (r) => r.category === cat && (r.agent_id === ctxAgent || r.agent_id === null),
      );
    });

    // Ambient context is agent-B (the would-be leak); the query routes to A.
    const skills = await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B' },
      () =>
        adapter.findActive({
          tenant_id: 'tenant-1',
          agent_id: 'agent-A',
          applicable_to_intent: 'x',
        }),
    );
    const ids = skills.map((s) => s.id);
    expect(ids).toContain('s_A'); // routed agent's own skill
    expect(ids).toContain('s_shared'); // tenant-wide → shared by design
    expect(ids).not.toContain('s_B'); // another agent's skill MUST NOT leak
  });

  it("item 5 — find() resolves own + tenant-wide skills but never another agent's", async () => {
    const store = seededStore();
    // Reproduce getById's agent-scope post-filter (skills-repo.ts getById).
    mockGetById.mockImplementation(async (id: string) => {
      const ctxAgent = getCurrentAgent();
      const row = store.find((r) => r.id === id);
      if (!row) return null;
      if (row.agent_id !== null && row.agent_id !== ctxAgent) return null;
      return row;
    });

    const scope = { tenant_id: 'tenant-1', agent_id: 'agent-A' };
    // Ambient is agent-B throughout; the routed scope (A) must govern.
    const own = await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B' },
      () => adapter.find('s_A', scope),
    );
    const shared = await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B' },
      () => adapter.find('s_shared', scope),
    );
    const leaked = await runWithTenantContext(
      { tenant_id: 'tenant-1', agent_id: 'agent-B' },
      () => adapter.find('s_B', scope),
    );
    expect(own?.id).toBe('s_A');
    expect(shared?.id).toBe('s_shared');
    expect(leaked).toBeNull(); // agent-B's skill never resolves under routed A
  });

  it('item 6 — concurrent findActive calls keep their own routed scope (AsyncLocalStorage isolation)', async () => {
    const observed = new Set<string>();
    mockListByCategory.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0)); // force the calls to interleave
      observed.add(getCurrentAgent());
      return [];
    });

    await Promise.all([
      runWithTenantContext(
        { tenant_id: 'tenant-1', agent_id: 'ambient-X' },
        () => adapter.findActive({ tenant_id: 'tenant-1', agent_id: 'routed-A' }),
      ),
      runWithTenantContext(
        { tenant_id: 'tenant-1', agent_id: 'ambient-Y' },
        () => adapter.findActive({ tenant_id: 'tenant-1', agent_id: 'routed-B' }),
      ),
    ]);

    expect(observed.has('routed-A')).toBe(true);
    expect(observed.has('routed-B')).toBe(true);
    // Ambient contexts must never have been observed by the P9a lookups even
    // though the two requests were in flight simultaneously.
    expect(observed.has('ambient-X')).toBe(false);
    expect(observed.has('ambient-Y')).toBe(false);
  });
});
