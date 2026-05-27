/**
 * Issue #218 — Cross-tenant isolation @ PRODUCTION ENTRY-POINTS.
 *
 * Codex PR #222 review, item 7 (scope). Sibling specs cover:
 *   - `skills-repo-cross-tenant-isolation.spec.ts` — the REAL skillsRepo against
 *     in-memory fake-Drizzle, exercising every read method's WHERE clause.
 *   - `decision-prod-env-skills.spec.ts` — the DE adapter's contract: every
 *     P9a lookup runs under the ROUTED `{tenant_id, agent_id}`, never ambient.
 *
 * What was NOT covered before this spec: the OTHER production callers that
 * expose skills to runtime. The review's item 7 lists:
 *   - `runSkill` — direct `skillsRepo.findActive` call (Gate 2).
 *   - `buildSkillSlice(ctx)` — `skillsRepo.getById` + `listByCategory` calls.
 *   - selector/action paths — go through the DE adapter, already covered.
 *   - `skill-proposer` duplicate-detection — `skillsRepo.findActive` call.
 *
 * Strategy: mock `skillsRepo` so it OBSERVES the ambient
 * `{tenant_id, agent_id}` at the moment each call is made (via
 * `runWithTenantContext`-aware `getCurrentTenant`/`getCurrentAgent`) — and
 * assert that the OBSERVED context equals the ROUTED tenant the caller intended.
 * This is the same delegation-shape pattern used for the adapter (non-tautological),
 * because the underlying SQL filtering is proved by the sibling specs.
 *
 * IMPORTANT (open question for the owner, NOT changed in this PR):
 *   `buildSkillSlice(ctx)` does NOT internally enforce `runWithTenantContext`.
 *   It takes `tenant_id` + `agent_id` in its argument object but the only
 *   tenant scoping comes from the CALLER having already entered
 *   `runWithTenantContext`. We test the CONTRACT: when the caller enters
 *   `runWithTenantContext({tenant_id, agent_id})` matching ctx.tenant_id, the
 *   slice contains only that tenant's skills. We DO NOT test the case where
 *   the caller forgets to enter the context with a matching tenant — that
 *   reveals a contract gap that the owner must decide whether to close by
 *   wrapping reads in `runWithTenantContext(ctx)` inside buildSkillSlice
 *   itself. See PR comment for the documented finding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, getCurrentAgent } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Hoisted mocks for skillsRepo + capabilityProposalsRepo (used by proposer).
// ---------------------------------------------------------------------------
const {
  mockFindActive,
  mockGetById,
  mockListByCategory,
  mockCreateProposal,
} = vi.hoisted(() => ({
  mockFindActive: vi.fn(),
  mockGetById: vi.fn(),
  mockListByCategory: vi.fn(),
  mockCreateProposal: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    skillsRepo: {
      findActive: mockFindActive,
      getById: mockGetById,
      listByCategory: mockListByCategory,
      // unused but keep shape parity
      propose: vi.fn(),
      activate: vi.fn(),
      deprecate: vi.fn(),
      rollback: vi.fn(),
      getByDescriptor: vi.fn(),
      listVersions: vi.fn(async () => []),
      listAll: vi.fn(async () => []),
      listSummaries: vi.fn(async () => []),
      listSummariesPage: vi.fn(async () => ({ items: [], hasMore: false })),
    },
    capabilityProposalsRepo: {
      ...actual.capabilityProposalsRepo,
      create: mockCreateProposal,
    },
  };
});

vi.mock('@/control-plane/skill-registry/skills-repo.js', () => ({
  skillsRepo: {
    findActive: mockFindActive,
    getById: mockGetById,
    listByCategory: mockListByCategory,
    propose: vi.fn(),
    activate: vi.fn(),
    deprecate: vi.fn(),
    rollback: vi.fn(),
    getByDescriptor: vi.fn(),
    listVersions: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    listSummaries: vi.fn(async () => []),
    listSummariesPage: vi.fn(async () => ({ items: [], hasMore: false })),
  },
  SKILLS_LIST_MAX_LIMIT: 200,
}));

// Mock the db client: chainable select/from/where/groupBy for skill-proposer's
// scanForSkillPatterns, plus stubs for the other call sites. The withTx stub
// is a pass-through.
vi.mock('@/db/client.js', async () => {
  const mockDb: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockResolvedValue([]),
  };
  return {
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    db: mockDb,
    pool: {},
    isDbConnected: () => true,
    probeDb: async () => true,
    shutdownDb: async () => {},
  };
});

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(async (_opts: any, fn: any) => {
    try {
      const out = await fn();
      return { output: out, status: 'success', fallback_triggered: false, latency_ms: 1 };
    } catch {
      return { output: null, status: 'error', fallback_triggered: true, latency_ms: 1 };
    }
  }),
}));

vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: {
    resolveDescriptors: vi.fn(async () => ({ resolved: [], unresolved: [] })),
  },
}));

vi.mock('@/skills/modes/prompt-only.js', () => ({
  promptOnlyMode: vi.fn(async () => ({})),
  parseJsonResponse: vi.fn(),
}));
vi.mock('@/skills/modes/procedure-adapter.js', () => ({
  procedureAdapterMode: vi.fn(async () => ({})),
}));
vi.mock('@/skills/modes/tool-mediated.js', () => ({
  toolMediatedMode: vi.fn(async () => ({})),
  setToolDispatcher: vi.fn(),
}));
vi.mock('@/skills/modes/evaluator.js', () => ({
  evaluatorMode: vi.fn(async () => ({})),
  parseEvaluatorOutput: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared seed: cross-tenant skills as plain JS objects. We use these from
// inside the mock to simulate the production query.
// ---------------------------------------------------------------------------
function mkRow(over: {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  descriptor?: string;
  category?: string;
}) {
  return {
    id: over.id,
    tenant_id: over.tenant_id,
    agent_id: over.agent_id,
    skill_descriptor: over.descriptor ?? over.id,
    category: over.category ?? 'tool_mediated',
    execution_mode: 'prompt_only',
    goal: 'g',
    when_to_use: '',
    procedure: { system_prompt: 's' },
    constraints: [],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    allowed_tools: [],
    policy_descriptors: [],
    success_criteria: [],
    failure_modes: [],
    runtime_hints: {},
    status: 'active',
    version: 1,
    proposed_by: 'u',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: new Date(),
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
  };
}

const CROSS_TENANT_STORE = [
  mkRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A', descriptor: 'shared.descr', category: 'tool_mediated' }),
  mkRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null,      descriptor: 'shared.descr', category: 'tool_mediated' }),
  mkRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B', descriptor: 'shared.descr', category: 'tool_mediated' }),
  mkRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null,      descriptor: 'shared.descr', category: 'tool_mediated' }),
];

beforeEach(async () => {
  vi.clearAllMocks();
  // Default: no rows. Tests override per scenario.
  mockFindActive.mockResolvedValue(null);
  mockGetById.mockResolvedValue(null);
  mockListByCategory.mockResolvedValue([]);
  // Feature flag default: enabled (vi.clearAllMocks resets the implementation
  // set in vi.mock, so re-arm it here per existing skill-proposer.spec.ts).
  const { featureFlags } = await import('@/config/feature-flags.js');
  (featureFlags.isEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

// ===========================================================================
// 1. runSkill — direct skillsRepo.findActive call (Gate 2)
// ===========================================================================
describe('item 7 — runSkill cross-tenant isolation', () => {
  it('runSkill: findActive runs under the AMBIENT tenant-context — observes routed tenant-A, not tenant-B', async () => {
    let observedTenant: string | undefined;
    let observedAgent: string | undefined;
    mockFindActive.mockImplementation(async () => {
      // Mirror the production behaviour: skillsRepo's findActive uses
      // getCurrentTenant()/getCurrentAgent() to scope. We OBSERVE what it
      // would see and return a tenant-scoped row consistent with that.
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      return CROSS_TENANT_STORE.find(
        (r) =>
          r.skill_descriptor === 'shared.descr' &&
          r.tenant_id === observedTenant &&
          (r.agent_id === observedAgent || r.agent_id === null),
      ) ?? null;
    });

    const { runSkill } = await import('@/skills/skill-runner.js');
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        runSkill({
          skill_descriptor: 'shared.descr',
          input: {},
          triggered_by: 'user_message',
          conversa_id: 'c-1',
          turno_id: 't-1',
        }),
    );

    // The runner picked up the tenant-A row (tenant scope observed correctly).
    expect(observedTenant).toBe('tenant-A');
    expect(observedAgent).toBe('agent-A');
    // The resolved skill was tenant-A's; never tenant-B's.
    expect(result.trace.skill_id).toBe('s_A_owned');
    // Sanity: the result is NOT pointing to any tenant-B id.
    expect(['s_B_owned', 's_B_shared']).not.toContain(result.trace.skill_id);
  });

  it('runSkill: symmetric — running as tenant-B/agent-B never resolves tenant-A skills', async () => {
    let observedTenant: string | undefined;
    let observedAgent: string | undefined;
    mockFindActive.mockImplementation(async () => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      return CROSS_TENANT_STORE.find(
        (r) =>
          r.skill_descriptor === 'shared.descr' &&
          r.tenant_id === observedTenant &&
          (r.agent_id === observedAgent || r.agent_id === null),
      ) ?? null;
    });

    const { runSkill } = await import('@/skills/skill-runner.js');
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        runSkill({
          skill_descriptor: 'shared.descr',
          input: {},
          triggered_by: 'user_message',
          conversa_id: 'c-1',
          turno_id: 't-1',
        }),
    );

    expect(observedTenant).toBe('tenant-B');
    expect(observedAgent).toBe('agent-B');
    expect(result.trace.skill_id).toBe('s_B_owned');
    expect(['s_A_owned', 's_A_shared']).not.toContain(result.trace.skill_id);
  });

  it('runSkill: defence-in-depth — if findActive somehow leaked a cross-tenant skill, assertAgentScope catches it', async () => {
    // Force findActive to return a leaked tenant-B row even though we are in
    // tenant-A context — simulating a future repo regression. runSkill's
    // assertAgentScope (Gate 1.5b) must reject with agent_scope_violation
    // BEFORE the skill executes.
    mockFindActive.mockImplementation(async () => {
      const leaked = CROSS_TENANT_STORE.find((r) => r.id === 's_B_owned')!;
      return leaked;
    });

    const { runSkill } = await import('@/skills/skill-runner.js');
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        runSkill({
          skill_descriptor: 'shared.descr',
          input: {},
          triggered_by: 'user_message',
          conversa_id: 'c-1',
          turno_id: 't-1',
        }),
    );

    // The runner detected the cross-tenant skill and refused — proves the
    // runtime has a SECOND line of defence even if the repo somehow leaked.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent_scope_violation');
  });
});

// ===========================================================================
// 2. buildSkillSlice — skillsRepo.getById + listByCategory calls
//
// Contract test (per dispatcher instructions): assert that buildSkillSlice
// only returns tenant-scoped skills WHEN CALLED INSIDE runWithTenantContext.
// We DO NOT change production code: if buildSkillSlice itself doesn't
// internally enforce/assert tenant context (it doesn't — see the FILE-LEVEL
// docstring above), that is an OPEN QUESTION for the owner, not a fix here.
// ===========================================================================
describe('item 7 — buildSkillSlice cross-tenant isolation (contract test)', () => {
  it('buildSkillSlice: when caller enters runWithTenantContext(tenant-A), every skillsRepo lookup observes tenant-A', async () => {
    const observed: Array<{ tenant: string; agent: string }> = [];
    const recordObservation = async () => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observed.push({ tenant: getCurrentTenant(), agent: getCurrentAgent() });
    };
    mockGetById.mockImplementation(async (id: string) => {
      await recordObservation();
      // Return the tenant-A row if it exists in store under that ID.
      return CROSS_TENANT_STORE.find((r) => r.id === id && r.tenant_id === 'tenant-A') ?? null;
    });
    mockListByCategory.mockImplementation(async () => {
      await recordObservation();
      return [];
    });

    const { buildSkillSlice } = await import('@/skills/skill-slice-builder.js');
    const { sliceCache } = await import('@/skills/cache.js');
    await sliceCache.clear();

    const slice = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        buildSkillSlice({
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          decision: {
            routing: {
              selected_skill_id: 's_A_owned',
              candidate_skill_ids: ['s_A_owned'],
            },
          },
        }),
    );

    expect(observed.length).toBeGreaterThan(0);
    // Every lookup observed tenant-A — buildSkillSlice did not silently
    // re-pin or escape the caller's context.
    for (const o of observed) {
      expect(o.tenant).toBe('tenant-A');
      expect(o.agent).toBe('agent-A');
    }
    expect(slice.selected?.id).toBe('s_A_owned');
  });

  it('buildSkillSlice: symmetric — under runWithTenantContext(tenant-B), no tenant-A skill is ever surfaced even if its ID is requested', async () => {
    // Both s_A_owned and s_B_owned exist; the slice asks for s_A_owned BUT
    // runs under tenant-B context. skillsRepo.getById (real repo) would
    // return null for a tenant-A ID under tenant-B scope. The mocked impl
    // mirrors that behaviour.
    const observed: Array<{ tenant: string; agent: string }> = [];
    mockGetById.mockImplementation(async (id: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observed.push({ tenant: getCurrentTenant(), agent: getCurrentAgent() });
      const ctxTenant = getCurrentTenant();
      const row = CROSS_TENANT_STORE.find((r) => r.id === id && r.tenant_id === ctxTenant);
      return row ?? null;
    });
    mockListByCategory.mockResolvedValue([]);

    const { buildSkillSlice } = await import('@/skills/skill-slice-builder.js');
    const { sliceCache } = await import('@/skills/cache.js');
    await sliceCache.clear();

    const slice = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        buildSkillSlice({
          // ctx.tenant_id = tenant-B (matches the runWithTenantContext above)
          tenant_id: 'tenant-B',
          agent_id: 'agent-B',
          decision: {
            routing: {
              // Ask for tenant-A's ID — leak path. The slice must NOT surface it.
              selected_skill_id: 's_A_owned',
              candidate_skill_ids: ['s_A_owned', 's_A_shared'],
            },
          },
        }),
    );

    // Every observation under tenant-B; no tenant-A skill resolved.
    for (const o of observed) {
      expect(o.tenant).toBe('tenant-B');
    }
    expect(slice.selected).toBeUndefined(); // tenant-A id never resolves under tenant-B
    expect(slice.candidates).toEqual([]); // ditto for candidates
  });
});

// ===========================================================================
// 3. skill-proposer — duplicate-detection findActive call
//
// The proposer's `detectAndProposeSkill` calls `scanForSkillPatterns` (db
// query against `cognitive_module_log`) and then for each detected pattern
// calls `skillsRepo.findActive(suggested_descriptor)` to skip duplicates. The
// `scanForSkillPatterns` step also reads from `db` — both queries observe the
// ambient tenant-context. We exercise the duplicate-detection branch by
// canning the db `groupBy` result (the bottom of `scanForSkillPatterns`) and
// then asserting that `findActive` observes the routed tenant.
// ===========================================================================
async function getMockedDb(): Promise<any> {
  const mod = await import('@/db/client.js');
  return (mod as any).db;
}

describe('item 7 — skill-proposer duplicate-detection cross-tenant isolation', () => {
  it('detectAndProposeSkill: findActive(suggested_descriptor) runs under the AMBIENT tenant; tenant-A pattern never sees tenant-B duplicate', async () => {
    const mockDb = await getMockedDb();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    // Use a module_name shaped so `suggested_descriptor` (lower-cased, non
    // alphanumerics → underscore) matches our seed's `skill_descriptor`.
    mockDb.groupBy.mockResolvedValue([
      { module_name: 'shared_descr', occurrences: 5 },
    ]);

    let observedTenant: string | undefined;
    let observedAgent: string | undefined;
    mockFindActive.mockImplementation(async (_descriptor: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      // proposer slugifies module_name → 'shared_descr'. Find rows by THAT
      // shape so the mock simulates a real duplicate in the routed tenant.
      const row = CROSS_TENANT_STORE.find(
        (r) =>
          r.id === `s_${observedTenant === 'tenant-A' ? 'A' : 'B'}_dup` &&
          r.tenant_id === observedTenant &&
          (r.agent_id === observedAgent || r.agent_id === null),
      );
      return row ?? null;
    });
    mockCreateProposal.mockResolvedValue({ id: 'prop-1' });

    // Seed an extra row with descriptor === 'shared_descr' so the duplicate
    // check finds something. (CROSS_TENANT_STORE uses 'shared.descr' which
    // doesn't match the slugified descriptor produced by scanForSkillPatterns.)
    const dupRow = mkRow({
      id: 's_A_dup',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      descriptor: 'shared_descr',
    });
    CROSS_TENANT_STORE.push(dupRow);

    try {
      const { detectAndProposeSkill } = await import('@/cognition/skill-proposer.js');
      const result = await runWithTenantContext(
        { tenant_id: 'tenant-A', agent_id: 'agent-A' },
        () => detectAndProposeSkill({ window_days: 7 }),
      );

      expect(observedTenant).toBe('tenant-A');
      expect(observedAgent).toBe('agent-A');
      // Duplicate detected → skipped, NOT proposed.
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.proposed).toBe(0);
    } finally {
      // Pop the test-local seed row so other tests aren't polluted.
      const idx = CROSS_TENANT_STORE.indexOf(dupRow);
      if (idx >= 0) CROSS_TENANT_STORE.splice(idx, 1);
    }
  });

  it("detectAndProposeSkill: symmetric — tenant-B pattern detection never sees tenant-A's row as a 'duplicate'", async () => {
    const mockDb = await getMockedDb();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockResolvedValue([
      { module_name: 'shared_descr', occurrences: 5 },
    ]);

    let observedTenant: string | undefined;
    let observedAgent: string | undefined;
    mockFindActive.mockImplementation(async (descriptor: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      const row = CROSS_TENANT_STORE.find(
        (r) =>
          r.skill_descriptor === descriptor &&
          r.tenant_id === observedTenant &&
          (r.agent_id === observedAgent || r.agent_id === null),
      );
      return row ?? null;
    });
    mockCreateProposal.mockResolvedValue({ id: 'prop-1' });

    // Seed BOTH tenants with a 'shared_descr' duplicate so symmetric works.
    const dupA = mkRow({ id: 's_A_dup', tenant_id: 'tenant-A', agent_id: 'agent-A', descriptor: 'shared_descr' });
    const dupB = mkRow({ id: 's_B_dup', tenant_id: 'tenant-B', agent_id: 'agent-B', descriptor: 'shared_descr' });
    CROSS_TENANT_STORE.push(dupA, dupB);

    try {
      const { detectAndProposeSkill } = await import('@/cognition/skill-proposer.js');
      const result = await runWithTenantContext(
        { tenant_id: 'tenant-B', agent_id: 'agent-B' },
        () => detectAndProposeSkill({ window_days: 7 }),
      );

      expect(observedTenant).toBe('tenant-B');
      expect(observedAgent).toBe('agent-B');
      // tenant-B finds its OWN s_B_dup duplicate. Key non-leak: observed = tenant-B,
      // never tenant-A. The mock's tenant_id filter is what guarantees this.
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      for (const r of [dupA, dupB]) {
        const idx = CROSS_TENANT_STORE.indexOf(r);
        if (idx >= 0) CROSS_TENANT_STORE.splice(idx, 1);
      }
    }
  });

  it('detectAndProposeSkill: when only the OTHER tenant has a matching active skill, current tenant proposes (no cross-tenant duplicate suppression)', async () => {
    const mockDb = await getMockedDb();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockResolvedValue([
      { module_name: 'shared_descr', occurrences: 5 },
    ]);

    // findActive returns rows scoped by the AMBIENT context. We simulate a
    // pruned store where ONLY tenant-A has the descriptor active — tenant-B
    // sees NO duplicate. If a missing `tenant_id` filter let tenant-A's row
    // leak into tenant-B's check, the proposer would skip; we expect propose.
    mockFindActive.mockImplementation(async (descriptor: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      const ctxTenant = getCurrentTenant();
      const ctxAgent = getCurrentAgent();
      const row = CROSS_TENANT_STORE.find(
        (r) =>
          r.skill_descriptor === descriptor &&
          r.tenant_id === ctxTenant &&
          // Simulate: ONLY tenant-A has the row active. tenant-B's repo
          // returns null for the same descriptor.
          r.tenant_id === 'tenant-A' &&
          (r.agent_id === ctxAgent || r.agent_id === null),
      );
      return row ?? null;
    });
    mockCreateProposal.mockResolvedValue({ id: 'prop-new' });

    // Seed ONLY tenant-A with the slugified duplicate. tenant-B has NOTHING.
    const dupA = mkRow({ id: 's_A_dup', tenant_id: 'tenant-A', agent_id: 'agent-A', descriptor: 'shared_descr' });
    CROSS_TENANT_STORE.push(dupA);

    try {
      // Run as tenant-B → findActive returns null in tenant-B context → proposer
      // creates a new proposal. If tenant_id filter were missing server-side,
      // tenant-A's row would surface and the proposer would skip.
      const { detectAndProposeSkill } = await import('@/cognition/skill-proposer.js');
      const result = await runWithTenantContext(
        { tenant_id: 'tenant-B', agent_id: 'agent-B' },
        () => detectAndProposeSkill({ window_days: 7 }),
      );

      expect(result.proposed).toBe(1);
      expect(mockCreateProposal).toHaveBeenCalledTimes(1);
    } finally {
      const idx = CROSS_TENANT_STORE.indexOf(dupA);
      if (idx >= 0) CROSS_TENANT_STORE.splice(idx, 1);
    }
  });
});

// ===========================================================================
// 4. selector/action paths — go through the DE adapter, which is covered by
// `decision-prod-env-skills.spec.ts`. For end-to-end coverage at this layer
// we add a smoke test that EXPLICITLY routes through the adapter+selector,
// asserting no tenant-B skill becomes a candidate under tenant-A.
// ===========================================================================
describe('item 7 — DE selector + adapter end-to-end cross-tenant isolation', () => {
  it('selector + adapter: tenant-A select() finds zero tenant-B candidates', async () => {
    // We bypass real DB by mocking listByCategory at the inner skillsRepo.
    // The adapter wraps in runWithTenantContext({routed tenant}); the mock
    // observes the wrapped context and returns the tenant-scoped rows.
    mockListByCategory.mockImplementation(async (cat: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      const ctxTenant = getCurrentTenant();
      const ctxAgent = getCurrentAgent();
      return CROSS_TENANT_STORE.filter(
        (r) =>
          r.category === cat &&
          r.tenant_id === ctxTenant &&
          (r.agent_id === ctxAgent || r.agent_id === null),
      );
    });

    const { createProductionDecisionEngineEnv } = await import(
      '@/runtime/decision/prod-env.js'
    );
    const { SkillSelectorImpl } = await import('@/runtime/decision/skill-selector.js');
    const env = createProductionDecisionEngineEnv();
    const selector = new SkillSelectorImpl({ skillsRepo: env.skillsRepo });

    // Build a tenant-A base packet; the routing target is tenant-A/agent-A.
    const base = {
      trace_id: 't1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
      channel: { id: 'ch1', kind: 'whatsapp' as const, is_locked_down: false },
      actor: { id: 'a1', is_authenticated: true },
      input: { content_ref: 'cref', received_at: new Date() },
    };

    // Ambient context = tenant-B (would-be leak). The adapter must re-pin
    // to the routed agent (base.agent_id = agent-A) AND the routed tenant
    // (base.tenant_id = tenant-A).
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => selector.select(base, { label: 'shared.descr', confidence: 0.9 }),
    );

    // Every candidate id must belong to tenant-A. We assert via the seed
    // naming convention 's_A_*' / 's_B_*'.
    for (const id of result.candidate_skill_ids) {
      expect(id.startsWith('s_A_')).toBe(true);
    }
    // No tenant-B id leaked in.
    expect(result.candidate_skill_ids).not.toContain('s_B_owned');
    expect(result.candidate_skill_ids).not.toContain('s_B_shared');
  });

  it('selector + adapter: symmetric — tenant-B select() finds zero tenant-A candidates', async () => {
    mockListByCategory.mockImplementation(async (cat: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      const ctxTenant = getCurrentTenant();
      const ctxAgent = getCurrentAgent();
      return CROSS_TENANT_STORE.filter(
        (r) =>
          r.category === cat &&
          r.tenant_id === ctxTenant &&
          (r.agent_id === ctxAgent || r.agent_id === null),
      );
    });

    const { createProductionDecisionEngineEnv } = await import(
      '@/runtime/decision/prod-env.js'
    );
    const { SkillSelectorImpl } = await import('@/runtime/decision/skill-selector.js');
    const env = createProductionDecisionEngineEnv();
    const selector = new SkillSelectorImpl({ skillsRepo: env.skillsRepo });

    const base = {
      trace_id: 't1',
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      channel: { id: 'ch1', kind: 'whatsapp' as const, is_locked_down: false },
      actor: { id: 'a1', is_authenticated: true },
      input: { content_ref: 'cref', received_at: new Date() },
    };

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () => selector.select(base, { label: 'shared.descr', confidence: 0.9 }),
    );

    for (const id of result.candidate_skill_ids) {
      expect(id.startsWith('s_B_')).toBe(true);
    }
    expect(result.candidate_skill_ids).not.toContain('s_A_owned');
    expect(result.candidate_skill_ids).not.toContain('s_A_shared');
  });

  it('action-decider: find(skill_id, scope) routes to the SCOPED tenant — tenant-A scope never resolves tenant-B id', async () => {
    mockGetById.mockImplementation(async (id: string) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      const ctxTenant = getCurrentTenant();
      const ctxAgent = getCurrentAgent();
      const row = CROSS_TENANT_STORE.find(
        (r) => r.id === id && r.tenant_id === ctxTenant,
      );
      if (!row) return null;
      if (row.agent_id !== null && row.agent_id !== ctxAgent) return null;
      return row;
    });

    const { createProductionDecisionEngineEnv } = await import(
      '@/runtime/decision/prod-env.js'
    );
    const env = createProductionDecisionEngineEnv();

    // Ambient = tenant-B; routed scope = tenant-A. Try to read tenant-B's id
    // under tenant-A scope → must return null (leak path).
    const leaked = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => env.skillsRepo.find('s_B_owned', { tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    );
    expect(leaked).toBeNull();

    // Sanity: tenant-A own id resolves under tenant-A scope.
    const own = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () => env.skillsRepo.find('s_A_owned', { tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    );
    expect(own?.id).toBe('s_A_owned');
  });
});
