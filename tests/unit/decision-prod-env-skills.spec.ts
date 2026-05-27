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
});
