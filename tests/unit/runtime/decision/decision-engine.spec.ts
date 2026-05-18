import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DecisionEngine,
  type DecisionEngineDeps,
} from '@/runtime/decision/decision-engine.ts';
import type {
  ActionDecider,
  AgentSelector,
  BlockDecision,
  EarlyPep,
  IntentClassifier,
  LockdownReader,
  MetricsClient,
  MidPep,
  PolicyDescriptorResolver,
  RiskScorer,
  SkillSelector,
  WorkflowSelector,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 'trace_test_1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

function mkDeps(overrides: Partial<DecisionEngineDeps> = {}): DecisionEngineDeps {
  const resolver: PolicyDescriptorResolver = {
    resolveDescriptors: vi.fn().mockResolvedValue([]),
  };
  const earlyPep: EarlyPep = {
    evaluate: vi.fn().mockResolvedValue({ pep: 'early', warnings: [] }),
  };
  const midPep: MidPep = {
    evaluate: vi.fn().mockResolvedValue({ pep: 'mid', warnings: [] }),
  };
  const intentClassifier: IntentClassifier = {
    classify: vi.fn().mockResolvedValue({ label: 'greet', confidence: 0.95 }),
  };
  const riskScorer: RiskScorer = {
    score: vi.fn().mockResolvedValue({
      level: 'low',
      reasons: [],
      requires_human_review: false,
    }),
  };
  const workflowSelector: WorkflowSelector = {
    select: vi.fn().mockResolvedValue({ mode: 'none' }),
  };
  const agentSelector: AgentSelector = {
    select: vi.fn().mockResolvedValue({ agent_id: 'agent_default' }),
  };
  const skillSelector: SkillSelector = {
    select: vi.fn().mockResolvedValue({
      selected_skill_id: 'skill_greet',
      candidate_skill_ids: ['skill_greet'],
    }),
  };
  const actionDecider: ActionDecider = {
    decide: vi.fn().mockResolvedValue({
      action_mode: 'respond',
      tool_permissions: {
        allowed_tools: [],
        blocked_tools: [],
        requires_confirmation: [],
      },
      context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
      evaluation_plan: {
        validators: [],
        llm_judge_required: false,
        human_review_required: false,
      },
      rationale: 'respond:skill_greet',
    }),
  };
  const lockdownReader: LockdownReader = {
    isChannelLockedDown: vi.fn().mockResolvedValue(false),
    isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
    tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
  };
  const metrics: MetricsClient = {
    increment: vi.fn(),
    recordHistogram: vi.fn(),
  };
  return {
    resolver,
    earlyPep,
    midPep,
    intentClassifier,
    riskScorer,
    workflowSelector,
    agentSelector,
    skillSelector,
    actionDecider,
    lockdownReader,
    metrics,
    clock: () => Date.now(),
    ...overrides,
  };
}

describe('P9b — DecisionEngine orchestrator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orchestrates all 8 steps for happy path', async () => {
    const deps = mkDeps();
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.packet.action_mode).toBe('respond');
    expect(r.packet.intent.label).toBe('greet');
    expect(r.packet.routing.agent_id).toBe('agent_default');
    expect(r.packet.routing.selected_skill_id).toBe('skill_greet');
    expect(r.packet.policy_decisions).toEqual([]);
    expect(r.block).toBeUndefined();

    // All upstream steps called
    expect(deps.resolver.resolveDescriptors).toHaveBeenCalledTimes(1);
    expect(deps.earlyPep.evaluate).toHaveBeenCalledTimes(1);
    expect(deps.intentClassifier.classify).toHaveBeenCalledTimes(1);
    expect(deps.riskScorer.score).toHaveBeenCalledTimes(1);
    expect(deps.workflowSelector.select).toHaveBeenCalledTimes(1);
    expect(deps.agentSelector.select).toHaveBeenCalledTimes(1);
    expect(deps.skillSelector.select).toHaveBeenCalledTimes(1);
    expect(deps.midPep.evaluate).toHaveBeenCalledTimes(1);
    expect(deps.actionDecider.decide).toHaveBeenCalledTimes(1);
  });

  it('early-exits if Early PEP blocks (no downstream steps called)', async () => {
    const block: BlockDecision = {
      pep: 'early',
      policy_id: 'system.channel_locked_down',
      rule_descriptor: 'channel.locked_down.global',
      decision: 'block',
      reason: 'lockdown',
      severity: 'high',
    };
    const deps = mkDeps({
      earlyPep: { evaluate: vi.fn().mockResolvedValue(block) },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.block).toBeDefined();
    expect(r.block?.decision).toBe('block');
    expect(r.packet.action_mode).toBe('escalate');
    expect(r.packet.policy_decisions).toHaveLength(1);
    expect(r.packet.policy_decisions[0]?.pep).toBe('early');

    // Downstream steps skipped
    expect(deps.intentClassifier.classify).not.toHaveBeenCalled();
    expect(deps.midPep.evaluate).not.toHaveBeenCalled();
    expect(deps.actionDecider.decide).not.toHaveBeenCalled();
  });

  it('early-exits if Mid PEP blocks (action_decider not called)', async () => {
    const block: BlockDecision = {
      pep: 'mid',
      policy_id: 'p_mid',
      rule_descriptor: 'transfer.restricted',
      decision: 'block',
      reason: 'restricted',
      severity: 'high',
    };
    const deps = mkDeps({
      midPep: { evaluate: vi.fn().mockResolvedValue(block) },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.block).toBeDefined();
    expect(r.packet.action_mode).toBe('ask_clarification'); // block mid -> ask
    expect(r.packet.policy_decisions[0]?.pep).toBe('mid');
    expect(deps.actionDecider.decide).not.toHaveBeenCalled();
  });

  it('returns escalate when Mid PEP escalates', async () => {
    const block: BlockDecision = {
      pep: 'mid',
      policy_id: 'p_esc',
      rule_descriptor: 'risk.escalate',
      decision: 'escalate',
      reason: 'risk',
      severity: 'high',
    };
    const deps = mkDeps({
      midPep: { evaluate: vi.fn().mockResolvedValue(block) },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.packet.action_mode).toBe('escalate');
  });

  it('handles require_dual_approval as escalate with approval_class rationale', async () => {
    const deps = mkDeps({
      midPep: {
        evaluate: vi.fn().mockResolvedValue({
          pep: 'mid',
          policy_id: 'p_dual',
          rule_descriptor: 'dual.required',
          decision: 'require_dual_approval',
          reason: 'high amount',
          approval_class: 'owner_plus_compliance',
        }),
      },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.packet.action_mode).toBe('escalate');
    expect(r.packet.rationale).toContain('owner_plus_compliance');
    expect(r.packet.policy_decisions.some(
      (d) => d.decision === 'require_dual_approval',
    )).toBe(true);
  });

  it('records metrics for each step', async () => {
    const deps = mkDeps();
    const engine = new DecisionEngine(deps);
    await engine.run({ base: mkBase() });
    expect(deps.metrics?.recordHistogram).toHaveBeenCalledWith(
      'decision_engine.duration_ms',
      expect.any(Number),
    );
    expect(deps.metrics?.recordHistogram).toHaveBeenCalledWith(
      'decision_engine.sub_duration_ms',
      expect.any(Number),
      expect.objectContaining({ step: expect.any(String) }),
    );
    expect(deps.metrics?.increment).toHaveBeenCalledWith(
      'decision_engine.packet_emitted',
      expect.objectContaining({ action_mode: 'respond' }),
    );
  });

  it('passes resolved_policies once to both PEPs (no duplicate resolver call)', async () => {
    const resolver: PolicyDescriptorResolver = {
      resolveDescriptors: vi.fn().mockResolvedValue([
        { policy_id: 'p1', descriptor: 'd1' },
      ]),
    };
    const deps = mkDeps({ resolver });
    const engine = new DecisionEngine(deps);
    await engine.run({ base: mkBase() });
    expect(resolver.resolveDescriptors).toHaveBeenCalledTimes(1);
  });

  it('budget fallback returns ask_clarification when budget exhausted (non-sensitive tenant)', async () => {
    // Force step to take longer than total budget by manipulating clock.
    let now = 0;
    const clock = () => now;
    const deps = mkDeps({
      clock,
      intentClassifier: {
        classify: vi.fn().mockImplementation(async () => {
          now += 500; // exceeds 400ms budget
          return { label: 'greet', confidence: 0.9 };
        }),
      },
      lockdownReader: {
        isChannelLockedDown: vi.fn().mockResolvedValue(false),
        isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
        tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
      },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.fallback_applied).toBe('ask_clarification');
    expect(r.packet.action_mode).toBe('ask_clarification');
    expect(deps.metrics?.increment).toHaveBeenCalledWith(
      'decision_engine.budget_fallback',
      expect.objectContaining({ failed_step: expect.any(String) }),
    );
  });

  it('budget fallback returns escalate when tenant has sensitive context', async () => {
    let now = 0;
    const clock = () => now;
    const deps = mkDeps({
      clock,
      intentClassifier: {
        classify: vi.fn().mockImplementation(async () => {
          now += 500;
          return { label: 'greet', confidence: 0.9 };
        }),
      },
      lockdownReader: {
        isChannelLockedDown: vi.fn().mockResolvedValue(false),
        isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
        tenantHasSensitiveContext: vi.fn().mockResolvedValue(true),
      },
    });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() });
    expect(r.packet.action_mode).toBe('escalate');
    expect(r.fallback_applied).toBeNull();
  });

  it('preserves trace_id from base context in packet', async () => {
    const deps = mkDeps();
    const engine = new DecisionEngine(deps);
    const r = await engine.run({
      base: mkBase({ trace_id: 'trace_xyz' }),
    });
    expect(r.packet.trace_id).toBe('trace_xyz');
  });

  it('rethrows non-budget errors', async () => {
    const deps = mkDeps({
      intentClassifier: {
        classify: vi.fn().mockRejectedValue(new Error('unexpected')),
      },
    });
    const engine = new DecisionEngine(deps);
    await expect(engine.run({ base: mkBase() })).rejects.toThrow('unexpected');
  });

  it('Codex #103 — skill selector receives resolved agent.agent_id (not base.agent_id)', async () => {
    const skillSelector: SkillSelector = {
      select: vi.fn().mockResolvedValue({
        selected_skill_id: 'skill_greet',
        candidate_skill_ids: ['skill_greet'],
      }),
    };
    const agentSelector: AgentSelector = {
      select: vi.fn().mockResolvedValue({ agent_id: 'routed_agent_Y' }),
    };
    const deps = mkDeps({ skillSelector, agentSelector });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({
      base: mkBase({ agent_id: 'base_agent_X' }),
    });
    expect(r.packet.routing.agent_id).toBe('routed_agent_Y');
    // The third arg to skillSelector.select is the options object carrying
    // agent_id_override.
    const call = (skillSelector.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[2]).toMatchObject({ agent_id_override: 'routed_agent_Y' });
  });

  it('Codex #103 — slow resolver triggers deadline (hot path cannot hang on resolver)', async () => {
    // Resolver hangs forever; the deadline must fire and return fallback packet.
    const resolver: PolicyDescriptorResolver = {
      resolveDescriptors: vi.fn().mockImplementation(
        () => new Promise(() => {}),
      ),
    };
    const deps = mkDeps({ resolver });
    const engine = new DecisionEngine(deps);
    const t0 = Date.now();
    const r = await engine.run({ base: mkBase() });
    const elapsed = Date.now() - t0;
    expect(r.fallback_applied).toBe('ask_clarification');
    expect(r.packet.action_mode).toBe('ask_clarification');
    // Hot path total must stay near the 400ms budget even under hung resolver.
    expect(elapsed).toBeLessThan(800);
    expect(deps.metrics?.increment).toHaveBeenCalledWith(
      'decision_engine.budget_fallback',
      expect.objectContaining({ failed_step: 'resolver' }),
    );
  }, 5000);

  it('Codex #103 — hung intent classifier triggers deadline (PEPs still recorded)', async () => {
    const intentClassifier: IntentClassifier = {
      classify: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    const deps = mkDeps({ intentClassifier });
    const engine = new DecisionEngine(deps);
    const t0 = Date.now();
    const r = await engine.run({ base: mkBase() });
    const elapsed = Date.now() - t0;
    expect(r.fallback_applied).toBe('ask_clarification');
    expect(elapsed).toBeLessThan(800);
    expect(deps.metrics?.increment).toHaveBeenCalledWith(
      'decision_engine.budget_fallback',
      expect.objectContaining({ failed_step: 'intent' }),
    );
  }, 5000);

  it('Codex #103 — caller-supplied AbortSignal short-circuits engine into fallback', async () => {
    const controller = new AbortController();
    const intentClassifier: IntentClassifier = {
      classify: vi.fn().mockImplementation(async () => {
        // Trigger abort during step
        controller.abort();
        // Hang so the deadline fires
        return new Promise(() => {});
      }),
    };
    const deps = mkDeps({ intentClassifier });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase(), signal: controller.signal });
    expect(r.fallback_applied).toBe('ask_clarification');
  }, 5000);

  it('Codex #103 — pre-aborted signal returns fallback immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = mkDeps();
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase(), signal: controller.signal });
    // Pre-aborted: the first step's checkBudget→abort short-circuits.
    expect(r.fallback_applied).toBe('ask_clarification');
    expect(r.packet.action_mode).toBe('ask_clarification');
  });
});
