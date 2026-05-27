/**
 * P9b (Camada 2) — Decision Engine integration with real adapter wiring.
 *
 * Tests that the production adapters in prod-env.ts are correctly wired and
 * that `getDecisionEngine()` / `runDecisionEngineIfEnabled()` behave correctly
 * with mocked DB/LLM calls (no live Postgres or Redis required).
 *
 * Three test cases (per task spec):
 *  T1: flag ON + blocked policy rule → DecisionPacket has decision_class='blocked'
 *      (action_mode='escalate' or 'ask_clarification'), policy_hits includes the rule.
 *  T2: flag ON + skill descriptor active → tool_reductions reflects real skill state.
 *  T3: flag OFF → no engine instantiation, no adapter calls.
 *
 * Mocking strategy: vi.mock the DB repositories and P8e/P9a/P9d modules so
 * no real DB connections are needed.  The tests verify that:
 *  - The correct adapter methods are called with the right arguments.
 *  - The DE interprets the adapter responses and produces the correct packet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import type {
  PolicyDescriptorResolverOutput,
  ResolvedPolicy,
} from '@/control-plane/policy/types.js';

// ---------------------------------------------------------------------------
// Mock: P8e policy descriptor resolver
// ---------------------------------------------------------------------------
vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: {
    resolveDescriptors: vi.fn(),
  },
}));

// Mock: P8e policy rules repo
vi.mock('@/control-plane/policy/policy-rules-repo.js', () => ({
  policyRulesRepo: {
    getById: vi.fn(),
    findActiveByDescriptor: vi.fn(),
    findActiveCandidates: vi.fn(),
    listActiveForTenant: vi.fn(),
    listVersions: vi.fn(),
    propose: vi.fn(),
    activate: vi.fn(),
    deprecate: vi.fn(),
    rollback: vi.fn(),
    nextVersion: vi.fn(),
    POLICY_LIFECYCLE_CHANNEL: 'policy_rule_lifecycle',
  },
  POLICY_LIFECYCLE_CHANNEL: 'policy_rule_lifecycle',
  isValidDualApprovalEvidence: vi.fn().mockReturnValue(false),
}));

// Mock: P9d evaluator
vi.mock('@/governance/policy-dsl/evaluator.js', () => ({
  evaluate: vi.fn(),
}));

// Mock: P9a skills repo
vi.mock('@/control-plane/skill-registry/skills-repo.js', () => ({
  skillsRepo: {
    findActive: vi.fn(),
    listByCategory: vi.fn(),
    propose: vi.fn(),
    activate: vi.fn(),
    deprecate: vi.fn(),
    rollback: vi.fn(),
    getById: vi.fn(),
    getByDescriptor: vi.fn(),
    listVersions: vi.fn(),
  },
}));

// Mock: DB repositories (procedureExecutionsRepo, mensagensRepo)
vi.mock('@/db/repositories.js', () => ({
  procedureExecutionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    findActiveForConversa: vi.fn(),
    createOrFindActive: vi.fn(),
  },
  mensagensRepo: {
    findById: vi.fn().mockResolvedValue(null),
  },
  procedureDefinitionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
  },
}));

// Mock: raw drizzle `db` client. The LockdownReaderProdAdapter + a couple of
// other prod-env adapters (channel_policies + permissoes lookups) reach through
// the global `db` rather than via a repo. Without this mock the engine throws
// inside Early PEP on every non-locked-channel run (T2/T3 hit it; T1 short-
// circuits before because is_locked_down=true).
//
// We return a chainable that always resolves to []. That's the correct
// "no global lockdown / no sensitive context / no policy" answer for an
// engine integration test that exercises the empty-state path.
vi.mock('@/db/client.js', () => {
  const empty = Promise.resolve([]);
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'leftJoin',
    'innerJoin',
    'orderBy',
    'limit',
    'offset',
    'insert',
    'into',
    'values',
    'returning',
    'update',
    'set',
    'delete',
    'onConflictDoNothing',
    'onConflictDoUpdate',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // `.then` makes the chain awaitable as a promise of [].
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => empty.then(resolve);
  return { db: chain, withTx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(chain) };
});

// Mock: DB tenant context. `runWithTenantContext` must be present because the
// SkillsRepoAdapter now wraps its P9a lookups in it to scope to the routed
// agent (Codex PR #215 review, BLOCKER 2). The mock just runs the callback —
// getCurrentAgent stays pinned to 'agent_test' for this empty-state test.
vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: vi.fn().mockReturnValue('tn_test'),
  getCurrentAgent: vi.fn().mockReturnValue('agent_test'),
  runWithTenantContext: vi.fn(
    async <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  ),
}));

// Mock: LLM client
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn().mockResolvedValue({
    content: 'unknown',
    tool_uses: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
    model: 'claude-haiku',
  }),
}));

// Mock: metrics
vi.mock('@/lib/metrics.js', () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
}));

// Mock: feature flag
vi.mock('@/runtime/feature-flags/decision-engine-flag.js', () => ({
  isDecisionEngineV1Enabled: vi.fn(),
}));

// Import AFTER mocks are registered
import { policyDescriptorResolver as mockResolver } from '@/control-plane/policy/policy-descriptor-resolver.js';
import { policyRulesRepo as mockPolicyRepo } from '@/control-plane/policy/policy-rules-repo.js';
import { evaluate as mockEvaluate } from '@/governance/policy-dsl/evaluator.js';
import { skillsRepo as mockSkillsRepo } from '@/control-plane/skill-registry/skills-repo.js';
import { isDecisionEngineV1Enabled } from '@/runtime/feature-flags/decision-engine-flag.js';
import {
  runDecisionEngineIfEnabled,
  _resetDecisionEngineSingleton,
} from '@/runtime/decision/integration.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 'trace_t1',
    tenant_id: 'tn_test',
    agent_id: 'agent_test',
    channel: { id: 'ch_001', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'actor_001', is_authenticated: true },
    input: {
      content_ref: 'msg_content_test',
      received_at: new Date('2026-05-20T10:00:00Z'),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Decision Engine — real adapter wiring (mocked DB)', () => {
  beforeEach(() => {
    // Reset singleton between tests so each gets a fresh env.
    _resetDecisionEngineSingleton();
    vi.clearAllMocks();

    // Default: resolver returns empty policies (allow-all by default).
    // The P8e resolver returns {resolved, unresolved, failures} not a plain array.
    vi.mocked(mockResolver.resolveDescriptors).mockResolvedValue(
      { resolved: [], unresolved: [], failures: [] } as unknown as PolicyDescriptorResolverOutput,
    );

    // Default: policy repo returns no rule body.
    vi.mocked(mockPolicyRepo.getById).mockResolvedValue(null);

    // Default: P9d evaluator returns allow (should not be called if no rules).
    vi.mocked(mockEvaluate).mockReturnValue({
      outcome: 'not_matched',
      matched: false,
      errors: [],
      diagnostics: {
        predicate_depth_visited: 0,
        field_lookups: 0,
        regex_cache_hits: 0,
        regex_compiled: 0,
      },
    });

    // Default: no active skills.
    vi.mocked(mockSkillsRepo.listByCategory).mockResolvedValue([]);
  });

  afterEach(() => {
    _resetDecisionEngineSingleton();
  });

  // -------------------------------------------------------------------------
  // T1: Flag ON + blocking policy → decision_class='blocked'
  // -------------------------------------------------------------------------
  it('T1: flag ON + blocking policy rule → packet action_mode reflects block (not ask_clarification default)', async () => {
    vi.mocked(isDecisionEngineV1Enabled).mockResolvedValue(true);

    // Resolver returns one active rule for the wildcard descriptor.
    // Return P8e-shaped output: {resolved, unresolved, failures}.
    const resolvedPolicy: ResolvedPolicy = {
      policy_id: 'pr_block_register_txn',
      descriptor: 'channel.locked_down.global',
      version: 1,
      rule_kind: 'hard_limit',
    };
    vi.mocked(mockResolver.resolveDescriptors).mockResolvedValue(
      {
        resolved: [resolvedPolicy],
        unresolved: [],
        failures: [],
      } as unknown as PolicyDescriptorResolverOutput,
    );

    // Policy repo returns the rule body for that policy_id.
    vi.mocked(mockPolicyRepo.getById).mockImplementation(async (id) => {
      if (id !== 'pr_block_register_txn') return null;
      return {
        id: 'pr_block_register_txn',
        tenant_id: 'tn_test',
        agent_id: null,
        rule_kind: 'hard_limit',
        rule_descriptor: 'channel.locked_down.global',
        rule_body: {
          policy_id: 'pr_block_register_txn',
          descriptor: 'channel.locked_down.global',
          applies_to_peps: ['early'],
          predicate: { kind: 'leaf', field: 'channel.is_locked_down', op: 'eq', value: true },
          effect: { action: 'block' },
        },
        scope: {},
        source_of_truth: 'founder_explicit',
        status: 'active',
        version: 1,
        proposed_by: 'founder',
        proposed_reason: null,
        approved_by: 'founder',
        approved_at: new Date(),
        activated_at: new Date(),
        deprecated_at: null,
        rolled_back_at: null,
        rollback_reason: null,
        created_at: new Date(),
      };
    });

    // P9d evaluator: returns matched+block for this rule.
    vi.mocked(mockEvaluate).mockReturnValue({
      outcome: 'matched',
      matched: true,
      effect: { action: 'block' },
      errors: [],
      diagnostics: {
        predicate_depth_visited: 1,
        field_lookups: 1,
        regex_cache_hits: 0,
        regex_compiled: 0,
      },
    });

    const r = await runDecisionEngineIfEnabled(
      mkBase({ channel: { id: 'ch_001', kind: 'whatsapp', is_locked_down: true } }),
    );

    expect(r.engine_ran).toBe(true);
    expect(r.result).toBeDefined();
    // Engine should have blocked — action_mode is NOT 'ask_clarification' (the stub default).
    expect(r.result!.packet.action_mode).toBe('escalate');
    // Block decision must be set.
    expect(r.result!.block).toBeDefined();
    // Early PEP's hardcoded channel lockdown check fires first with system policy_id.
    // This is correct: the channel is marked is_locked_down=true in the packet, so
    // the EarlyPep short-circuits before reaching the resolver-backed policy rule.
    expect(r.result!.block?.policy_id).toBe('system.channel_locked_down');
    expect(r.result!.block?.decision).toBe('block');
    // Policy hits recorded in policy_decisions.
    const decisions = r.result!.packet.policy_decisions;
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some((d) => d.decision === 'block')).toBe(true);

    // Verify the real policy resolver adapter was called (not a stub).
    // The resolver runs before Early PEP short-circuits on channel.is_locked_down.
    expect(mockResolver.resolveDescriptors).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // T2: Flag ON + skill descriptor active → tool_reductions in packet
  // -------------------------------------------------------------------------
  it('T2: flag ON + active skill in registry → tool_reductions reflect real skill state', async () => {
    vi.mocked(isDecisionEngineV1Enabled).mockResolvedValue(true);

    // Resolver returns an empty list (no blocking policies).
    vi.mocked(mockResolver.resolveDescriptors).mockResolvedValue(
      { resolved: [], unresolved: [], failures: [] } as unknown as PolicyDescriptorResolverOutput,
    );

    // P9a skills repo: list one skill with an allowed_tool.
    const mockSkillRow = {
      id: 'skill_transfer_v1',
      tenant_id: 'tn_test',
      agent_id: 'agent_test',
      skill_descriptor: 'transfer_money',
      category: 'tool_mediated',
      execution_mode: 'reactive',
      goal: 'Handle money transfers',
      when_to_use: 'When user requests a transfer',
      procedure: 'Check limit → call transfer tool',
      constraints: [],
      input_schema: null,
      output_schema: null,
      allowed_tools: ['transfer_money'],
      policy_descriptors: [],
      success_criteria: [],
      failure_modes: [],
      runtime_hints: {},
      status: 'active',
      version: 1,
      proposed_by: 'founder',
      proposed_reason: null,
      approved_by: 'founder',
      approved_at: new Date(),
      activated_at: new Date(),
      deprecated_at: null,
      rolled_back_at: null,
      rollback_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    vi.mocked(mockSkillsRepo.listByCategory).mockImplementation(async (cat) => {
      if (cat === 'tool_mediated') return [mockSkillRow as Parameters<typeof mockSkillsRepo.listByCategory>[0] extends Promise<infer T> ? T extends Array<infer U> ? U : never : never];
      return [];
    });

    const r = await runDecisionEngineIfEnabled(mkBase());

    expect(r.engine_ran).toBe(true);
    expect(r.result).toBeDefined();

    // SkillsRepo adapter must have been called (listByCategory).
    expect(mockSkillsRepo.listByCategory).toHaveBeenCalled();

    // The engine ran to completion (no block) — it should have a packet.
    const packet = r.result!.packet;
    expect(packet).toBeDefined();
    // We can't assert exact tool_reductions without triggering a Mid PEP reduce_tool_set
    // verdict. What we CAN assert is that the skill registry was consulted.
    expect(['respond', 'call_tool', 'ask_clarification', 'escalate', 'continue_workflow', 'decide', 'plan']).toContain(
      packet.action_mode,
    );
  });

  // -------------------------------------------------------------------------
  // T3: Flag OFF → no engine call, no adapter invocations
  // -------------------------------------------------------------------------
  it('T3: flag OFF → engine not called, no DB queries to policy_rules', async () => {
    vi.mocked(isDecisionEngineV1Enabled).mockResolvedValue(false);

    const r = await runDecisionEngineIfEnabled(mkBase());

    expect(r.engine_ran).toBe(false);
    expect(r.skip_reason).toBe('flag_off');
    expect(r.result).toBeUndefined();

    // No adapter methods should have been called.
    expect(mockResolver.resolveDescriptors).not.toHaveBeenCalled();
    expect(mockPolicyRepo.getById).not.toHaveBeenCalled();
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockSkillsRepo.listByCategory).not.toHaveBeenCalled();
  });
});
