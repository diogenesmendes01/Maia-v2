/**
 * Issue #226 — `ActionDeciderImpl` fallback `skillsRepo.find` cross-tenant guard.
 *
 * Sibling spec to `tests/unit/skills/skill-entrypoints-cross-tenant.spec.ts`,
 * which proved the DE adapter's `find()` is tenant-scoped by construction but
 * never instantiated the real `ActionDeciderImpl`. The fallback path at
 * `src/runtime/decision/action-decider.ts:157,170-171` (where `selected_skill`
 * is absent so the decider falls into `this.deps.skillsRepo.find(...)`) was
 * therefore NOT exercised end-to-end.
 *
 * Strategy:
 *   1. Wire the REAL `ActionDeciderImpl` with the REAL production
 *      `skillsRepo` adapter from `createProductionDecisionEngineEnv()`.
 *   2. Mock only the inner P9a `skillsRepo.getById` (per the pattern from PR
 *      #222 and decision-prod-env-skills.spec.ts) so it OBSERVES the ambient
 *      tenant-context the adapter pins, and returns rows filtered by both
 *      tenant_id and agent_id — faithfully simulating the production
 *      `getById` WHERE clause (`tenant_id = getCurrentTenant()` + agent-scope
 *      post-filter).
 *   3. Drive `ActionDeciderImpl.decide` through the FALLBACK branch by setting
 *      `skill.selected_skill_id` WITHOUT `skill.selected_skill` — this is the
 *      only path that invokes `deps.skillsRepo.find()`.
 *   4. Assert that under tenant-A context, the decider NEVER returns a
 *      tenant-B skill (and symmetric direction).
 *   5. Include an adversarial seed (tenant-B inserted FIRST) per the
 *      `seedTenantWideOnlyBFirst` pattern from PR #222 — proves the guard
 *      fires regardless of insertion order in the underlying store.
 *
 * Item 2 outcome (issue body #2 — "confirm/harden the fallback `find()`"):
 *   The production `skillsRepo.find()` (prod-env.ts:426) wraps `getById` in
 *   `runWithTenantContext({tenant_id, agent_id})` pinned to the ROUTED scope
 *   passed by ActionDecider, and `getById` (skills-repo.ts:823) filters on
 *   `WHERE tenant_id = getCurrentTenant() AND id = ...` plus an agent-scope
 *   post-filter. Tenant-scoping is therefore enforced by construction in the
 *   WHERE clause — no production change needed. This spec proves the
 *   end-to-end invariant: the REAL ActionDeciderImpl driving the REAL adapter
 *   `find()` cannot resolve cross-tenant skills via the fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, getCurrentAgent } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — the inner P9a skillsRepo. Same shape used by PR #222 +
// decision-prod-env-skills.spec.ts so the adapter under test is untouched.
// ---------------------------------------------------------------------------
const { mockGetById, mockListByCategory } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockListByCategory: vi.fn(),
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

// Adapter factory + ActionDecider — import AFTER mocks are registered.
import { createProductionDecisionEngineEnv } from '@/runtime/decision/prod-env.js';
import { ActionDeciderImpl } from '@/runtime/decision/action-decider.js';
import type { ActionDeciderInput } from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

// ---------------------------------------------------------------------------
// Seed shape. Mirrors the rows returned by P9a `getById` — only the columns
// `skillRowToSkill` (prod-env.ts) projects from.
// ---------------------------------------------------------------------------
type SeedRow = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  skill_descriptor: string;
  category: 'tool_mediated' | 'respond' | 'decide' | string;
  execution_mode: 'prompt_only' | 'evaluator' | 'tool_mediated' | 'procedure_adapter';
  status: 'active' | 'deprecated' | 'draft';
  allowed_tools: string[];
  policy_descriptors: string[];
  runtime_hints: Record<string, unknown>;
  when_to_use: string;
  version: number;
};

function mkRow(over: {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  descriptor?: string;
  category?: SeedRow['category'];
  execution_mode?: SeedRow['execution_mode'];
}): SeedRow {
  return {
    id: over.id,
    tenant_id: over.tenant_id,
    agent_id: over.agent_id,
    skill_descriptor: over.descriptor ?? over.id,
    category: over.category ?? 'tool_mediated',
    execution_mode: over.execution_mode ?? 'tool_mediated',
    status: 'active',
    allowed_tools: ['tool_for_' + over.id],
    policy_descriptors: [],
    runtime_hints: {},
    when_to_use: '',
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Two-tenant store shared across tests. We rebuild it per test so seed
// insertion ORDER can be varied (adversarial direction below).
// ---------------------------------------------------------------------------
let STORE: SeedRow[] = [];

function seedDefault() {
  // tenant-A inserted BEFORE tenant-B (default direction).
  STORE = [
    mkRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    mkRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null      }),
    mkRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    mkRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null      }),
  ];
}

/**
 * Adversarial direction — tenant-B inserted FIRST. Mirrors the
 * `seedTenantWideOnlyBFirst` pattern from PR #222: if a regression silently
 * dropped the `tenant_id` filter from `getById`'s WHERE clause, the store-order
 * would dictate which row surfaces, and tenant-B's row would slide in front of
 * tenant-A's. With the filter present, only the routed tenant's row matches
 * and the order is irrelevant.
 */
function seedBFirst() {
  STORE = [
    mkRow({ id: 's_B_owned',  tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    mkRow({ id: 's_B_shared', tenant_id: 'tenant-B', agent_id: null      }),
    mkRow({ id: 's_A_owned',  tenant_id: 'tenant-A', agent_id: 'agent-A' }),
    mkRow({ id: 's_A_shared', tenant_id: 'tenant-A', agent_id: null      }),
  ];
}

/**
 * Mock impl that mirrors the production `getById` (skills-repo.ts:823):
 *   WHERE tenant_id = getCurrentTenant() AND id = $id
 *   then agent-scope post-filter (`agent_id IS NULL OR agent_id = ctxAgent`).
 *
 * This makes the mock a FAITHFUL simulator of the underlying WHERE+post-filter
 * — the adapter pins {tenant_id, agent_id} via runWithTenantContext, and the
 * mock observes BOTH via getCurrentTenant/getCurrentAgent. A regression in the
 * adapter (forgetting the wrap) would cause the mock to observe the AMBIENT
 * context and return the wrong tenant's row — surfacing as a cross-tenant
 * leak in the test below.
 */
function installGetByIdMock() {
  mockGetById.mockImplementation(async (id: string) => {
    const { getCurrentTenant } = await import('@/db/tenant-context.js');
    const ctxTenant = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const row = STORE.find((r) => r.id === id && r.tenant_id === ctxTenant);
    if (!row) return null;
    if (row.agent_id !== null && row.agent_id !== ctxAgent) return null;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Test helpers — build a BaseContextPacket and an ActionDeciderInput that
// drives the FALLBACK branch (selected_skill_id set, selected_skill absent).
// ---------------------------------------------------------------------------
function mkBase(tenant_id: string, agent_id: string): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id,
    agent_id,
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
  };
}

function mkInputFallback(args: {
  tenant_id: string;
  agent_id: string;
  selected_skill_id: string;
}): ActionDeciderInput {
  return {
    base: mkBase(args.tenant_id, args.agent_id),
    intent: { label: 'shared.descr', confidence: 0.9 },
    risk: { level: 'low', reasons: [], requires_human_review: false },
    workflow: { mode: 'none' },
    // FALLBACK PATH: selected_skill_id present, selected_skill ABSENT — so
    // ActionDecider must resolve via `deps.skillsRepo.find()` (action-decider.ts:161).
    skill: {
      selected_skill_id: args.selected_skill_id,
      candidate_skill_ids: [args.selected_skill_id],
    },
    midPepOutcome: { pep: 'mid', warnings: [] },
    earlyWarnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockResolvedValue(null);
  mockListByCategory.mockResolvedValue([]);
});

// ===========================================================================
// Issue #226 — REAL ActionDeciderImpl fallback through skillsRepo.find with
// cross-tenant guard.
// ===========================================================================
describe('issue #226 — ActionDeciderImpl fallback skillsRepo.find cross-tenant guard', () => {
  it('A→B leak path: tenant-A scope NEVER resolves tenant-B skill via the real ActionDecider fallback', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // Ambient context = tenant-B (the would-be leak). The decider operates on
    // base={tenant_id:tenant-A, agent_id:agent-A}, and the fallback `find()`
    // MUST pin to that scope — not the ambient tenant-B/agent-B.
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          // Ask for tenant-B's ID under tenant-A scope. The fallback `find()`
          // re-resolves under {tenant-A, agent-A}; getById's WHERE drops the
          // tenant-B row → null → ActionDecider emits ask_clarification.
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    // Production behaviour for a skill_id that does not exist in the routed
    // scope: ActionDecider emits ask_clarification with `skill_lookup_failed`
    // (action-decider.ts:181-189). The CRITICAL invariant is that the
    // tenant-B skill never surfaced — `allowed_tools` came up empty, NOT
    // loaded with tenant-B's `tool_for_s_B_owned`.
    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_owned');
    expect(result.tool_permissions.allowed_tools).toEqual([]);
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');

    // Adapter delegation observable: the underlying getById WAS called (the
    // fallback ran) and observed the ROUTED tenant-A, NEVER ambient tenant-B.
    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith('s_B_owned');
  });

  it('A→B leak path: sanity — tenant-A own skill resolves under tenant-A scope (the fallback IS exercised)', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' }, // ambient = tenant-B
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    // tenant-A's own tool_mediated skill resolves and routes to call_tool.
    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_owned');
    // No tenant-B leak — explicit non-tenant-B tool assertion.
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');
    expect(mockGetById).toHaveBeenCalledTimes(1);
  });

  it('B→A leak path (symmetric): tenant-B scope NEVER resolves tenant-A skill via the real ActionDecider fallback', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // Ambient = tenant-A; routed/decider scope = tenant-B. Ask for tenant-A's id.
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-B',
            agent_id: 'agent-B',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toEqual([]);
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_A_owned');

    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith('s_A_owned');
  });

  it('B→A leak path: sanity — tenant-B own skill resolves under tenant-B scope', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-A', agent_id: 'agent-A' }, // ambient = tenant-A
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-B',
            agent_id: 'agent-B',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_B_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_B_owned');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_A_owned');
  });

  // -------------------------------------------------------------------------
  // Adversarial seed: tenant-B FIRST. If a future regression dropped the
  // `tenant_id` filter, insertion order would matter and tenant-B's row
  // could slide ahead of tenant-A's. With the filter intact, this test
  // behaves identically to the default seed direction — proving the guard
  // is positional-insensitive.
  // -------------------------------------------------------------------------
  it('adversarial seed (tenant-B inserted FIRST): tenant-A scope still NEVER resolves tenant-B skill', async () => {
    seedBFirst();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_owned');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_owned');
  });

  it('adversarial seed (tenant-B inserted FIRST): tenant-A own skill still resolves under tenant-A scope', async () => {
    seedBFirst();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_owned',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_owned');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_owned');
  });

  // -------------------------------------------------------------------------
  // Tenant-wide leak path: a row with `agent_id IS NULL` is shared across
  // agents of the SAME tenant, but NEVER cross-tenant. Verify the fallback
  // never returns tenant-B's tenant-wide row under tenant-A scope.
  // -------------------------------------------------------------------------
  it('tenant-wide skill: tenant-A scope NEVER resolves tenant-B `agent_id IS NULL` skill via the fallback', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          // Ask for tenant-B's TENANT-WIDE id under tenant-A scope.
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_B_shared',
          }),
        ),
    );

    expect(result.action_mode).toBe('ask_clarification');
    expect(result.rationale).toBe('skill_lookup_failed:s_B_shared');
    expect(result.tool_permissions.allowed_tools).not.toContain('tool_for_s_B_shared');
  });

  it('tenant-wide skill: tenant-A scope DOES resolve tenant-A `agent_id IS NULL` skill (intra-tenant sharing is fine)', async () => {
    seedDefault();
    installGetByIdMock();

    const env = createProductionDecisionEngineEnv();
    const decider = new ActionDeciderImpl({ skillsRepo: env.skillsRepo });

    // A different agent inside tenant-A asks for the tenant-wide skill —
    // must resolve (tenant-wide is shared INSIDE the tenant by design).
    const result = await runWithTenantContext(
      { tenant_id: 'tenant-B', agent_id: 'agent-B' },
      () =>
        decider.decide(
          mkInputFallback({
            tenant_id: 'tenant-A',
            agent_id: 'agent-A',
            selected_skill_id: 's_A_shared',
          }),
        ),
    );

    expect(result.action_mode).toBe('call_tool');
    expect(result.rationale).toBe('call_tool:s_A_shared');
    expect(result.tool_permissions.allowed_tools).toContain('tool_for_s_A_shared');
  });
});
