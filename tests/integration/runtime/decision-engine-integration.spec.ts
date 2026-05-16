/**
 * P9b — Decision Engine end-to-end integration (7 scenarios per spec §10.2).
 *
 * Fixture: 1 tenant + 2 agents + 5 policy_rules (early/mid/dual/late
 * variants) + 3 skills (respond, tool_mediated, plan).
 *
 * Wires real implementations of Early/Mid PEPs + selectors + action decider
 * around mocked external deps (policy resolver/repo/evaluator, skills repo,
 * lockdown reader, channel policies). No DB hits.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDecisionEngine } from '@/runtime/decision/index.ts';
import type {
  ChannelPoliciesReader,
  ContentResolver,
  HaikuClient,
  LockdownReader,
  MetricsClient,
  PolicyDescriptorResolver,
  PolicyEvaluator,
  PolicyEvaluatorVerdict,
  PolicyRuleBody,
  PolicyRulesRepo,
  ProceduresRepo,
  ResolvedPolicy,
  Skill,
  SkillsRepo,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import { LatePepImpl } from '@/runtime/guardrails/late-pep.ts';
import type {
  AgentOutputCandidate,
  ExecutionContextPacket,
  SkillSchemaValidator,
} from '@/runtime/guardrails/types.js';

// ---------- Fixture builders ----------

interface Fixture {
  tenant_id: string;
  agents: string[];
  policies: Map<string, PolicyRuleBody>;
  skills: Map<string, Skill>;
  /** Same instance, exposed as both names so `createDecisionEngine(fixture)` works. */
  evaluator: PolicyEvaluator;
  policyEvaluator: PolicyEvaluator;
  resolver: PolicyDescriptorResolver;
  policyRepo: PolicyRulesRepo;
  skillsRepo: SkillsRepo;
  channelPolicies: ChannelPoliciesReader;
  lockdownReader: LockdownReader;
  proceduresRepo: ProceduresRepo;
  contentResolver: ContentResolver;
  haiku: HaikuClient;
  metrics: MetricsClient;
  /** allow tests to mutate verdict per policy_id */
  setVerdict(policy_id: string, verdict: PolicyEvaluatorVerdict): void;
  setChannelLockdown(value: boolean): void;
  setSensitive(value: boolean): void;
  setActiveExecution(execId: string | null): void;
  setContent(content: string): void;
}

function buildFixture(): Fixture {
  const tenant_id = 'tn_fixture';
  const agents = ['agent_a', 'agent_b'];

  // 5 policy rules covering all PEP coverage variants.
  const policies = new Map<string, PolicyRuleBody>([
    [
      'p_early_lock',
      {
        policy_id: 'p_early_lock',
        descriptor: 'channel.locked_down.global',
        applies_to_peps: ['early'],
      },
    ],
    [
      'p_mid_skill_restrict',
      {
        policy_id: 'p_mid_skill_restrict',
        descriptor: 'transfer.skill_restricted',
        applies_to_peps: ['mid'],
      },
    ],
    [
      'p_mid_dual',
      {
        policy_id: 'p_mid_dual',
        descriptor: 'transfer.dual_approval',
        applies_to_peps: ['mid'],
        rule_kind: 'dual_approval',
      },
    ],
    [
      'p_late_redact',
      {
        policy_id: 'p_late_redact',
        descriptor: 'output.pii_redaction',
        applies_to_peps: ['late'],
      },
    ],
    [
      'p_late_schema',
      {
        policy_id: 'p_late_schema',
        descriptor: 'output.schema_strict',
        applies_to_peps: ['late'],
      },
    ],
  ]);

  const skills = new Map<string, Skill>([
    [
      'skill_greet',
      {
        id: 'skill_greet',
        category: 'respond',
        priority: 5,
        status: 'active',
        applicable_to_intent: ['greet'],
      },
    ],
    [
      'skill_transfer',
      {
        id: 'skill_transfer',
        category: 'tool_mediated',
        priority: 3,
        status: 'active',
        applicable_to_intent: ['transfer_intent'],
        allowed_tools: ['transfer_money'],
        blocked_tools: ['delete_account'],
        requires_confirmation_tools: ['transfer_money'],
      },
    ],
    [
      'skill_plan',
      {
        id: 'skill_plan',
        category: 'plan',
        priority: 2,
        status: 'active',
      },
    ],
    [
      'skill_onboarding',
      {
        id: 'skill_onboarding',
        category: 'respond',
        priority: 5,
        status: 'active',
        applicable_to_intent: ['onboarding_next_step'],
      },
    ],
  ]);

  const verdicts = new Map<string, PolicyEvaluatorVerdict>();
  let isChannelLockedDown = false;
  let isSensitive = false;
  let activeExecutionId: string | null = null;
  let content = 'olá! tudo bem?';

  const evaluator: PolicyEvaluator = {
    evaluate: async (body) => {
      return verdicts.get(body.policy_id) ?? { action: 'allow', reason: 'default' };
    },
  };

  const policyRepo: PolicyRulesRepo = {
    getBody: async (id) => policies.get(id) ?? null,
    getBodySync: (id) => policies.get(id) ?? null,
  };

  const resolver: PolicyDescriptorResolver = {
    resolveDescriptors: async () => {
      const out: ResolvedPolicy[] = [];
      for (const body of policies.values()) {
        const resolved: ResolvedPolicy = {
          policy_id: body.policy_id,
          descriptor: body.descriptor,
        };
        if (body.applies_to_peps !== undefined) {
          resolved.applies_to_peps = body.applies_to_peps;
        }
        out.push(resolved);
      }
      return out;
    },
  };

  const skillsRepo: SkillsRepo = {
    findActive: async (query) => {
      const matches: Skill[] = [];
      for (const s of skills.values()) {
        if (
          query.applicable_to_intent &&
          s.applicable_to_intent &&
          s.applicable_to_intent.includes(query.applicable_to_intent)
        ) {
          matches.push(s);
        }
      }
      return matches;
    },
    find: async (id) => skills.get(id) ?? null,
  };

  const channelPolicies: ChannelPoliciesReader = {
    getForChannel: async (t, c) => ({
      tenant_id: t,
      channel_id: c,
      default_agent_id: 'agent_a',
    }),
  };

  const lockdownReader: LockdownReader = {
    isChannelLockedDown: async () => isChannelLockedDown,
    isTenantInGlobalLockdown: async () => false,
    tenantHasSensitiveContext: async () => isSensitive,
  };

  const proceduresRepo: ProceduresRepo = {
    findExecution: async (id) => {
      if (!activeExecutionId || id !== activeExecutionId) return null;
      return {
        execution_id: id,
        procedure_id: 'onboard_pf',
        procedure_domain: 'onboarding',
        ttl_remaining_ms: 60_000,
      };
    },
  };

  const contentResolver: ContentResolver = {
    text: async () => content,
  };

  const haiku: HaikuClient = {
    classify: vi
      .fn()
      .mockResolvedValue({ label: 'unknown', confidence: 0.4 }),
  };

  const metrics: MetricsClient = {
    increment: vi.fn(),
    recordHistogram: vi.fn(),
  };

  return {
    tenant_id,
    agents,
    policies,
    skills,
    evaluator,
    policyEvaluator: evaluator,
    resolver,
    policyRepo,
    skillsRepo,
    channelPolicies,
    lockdownReader,
    proceduresRepo,
    contentResolver,
    haiku,
    metrics,
    setVerdict(id, v) {
      verdicts.set(id, v);
    },
    setChannelLockdown(v) {
      isChannelLockedDown = v;
    },
    setSensitive(v) {
      isSensitive = v;
    },
    setActiveExecution(id) {
      activeExecutionId = id;
    },
    setContent(c) {
      content = c;
    },
  };
}

function mkBase(
  fixture: Fixture,
  overrides?: Partial<BaseContextPacket>,
): BaseContextPacket {
  return {
    trace_id: `trace_${Math.random().toString(36).slice(2)}`,
    tenant_id: fixture.tenant_id,
    agent_id: fixture.agents[0]!,
    channel: { id: 'ch_wpp_1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'actor_pf_1', is_authenticated: true },
    input: {
      content_ref: 'msg_ref_1',
      received_at: new Date('2026-05-15T10:00:00Z'),
    },
    ...overrides,
  };
}

// ---------- Tests ----------

describe('P9b — Decision Engine integration (7 cenários, spec §10.2)', () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = buildFixture();
  });

  it('Cenário 1: happy path respond (intent=greet, no blocks)', async () => {
    fixture.setContent('olá, tudo bem?');
    const engine = createDecisionEngine(fixture);
    const r = await engine.run({ base: mkBase(fixture) });

    expect(r.packet.action_mode).toBe('respond');
    expect(r.packet.intent.label).toBe('greet');
    expect(r.packet.routing.selected_skill_id).toBe('skill_greet');
    expect(r.packet.policy_decisions).toEqual([]);
    expect(r.block).toBeUndefined();
  });

  it('Cenário 2: early block (channel.is_locked_down=true)', async () => {
    const engine = createDecisionEngine(fixture);
    const r = await engine.run({
      base: mkBase(fixture, {
        channel: { id: 'ch_wpp_1', kind: 'whatsapp', is_locked_down: true },
      }),
    });

    expect(r.block).toBeDefined();
    expect(r.block?.decision).toBe('block');
    expect(r.packet.action_mode).toBe('escalate');
    expect(r.packet.policy_decisions[0]?.pep).toBe('early');
  });

  it('Cenário 3: mid block (skill restricted by policy)', async () => {
    fixture.setContent('quero transferir R$ 100');
    fixture.setVerdict('p_mid_skill_restrict', {
      action: 'block',
      reason: 'skill_transfer not allowed for this actor',
      severity: 'high',
    });

    const engine = createDecisionEngine(fixture);
    const r = await engine.run({ base: mkBase(fixture) });

    expect(r.block).toBeDefined();
    expect(r.block?.policy_id).toBe('p_mid_skill_restrict');
    expect(r.packet.action_mode).toBe('ask_clarification');
    expect(r.packet.policy_decisions[0]?.pep).toBe('mid');
  });

  it('Cenário 4: mid require_dual_approval (action=escalate)', async () => {
    fixture.setContent('quero transferir R$ 5000');
    fixture.setVerdict('p_mid_dual', {
      action: 'require_dual_approval',
      reason: 'amount above threshold',
      parameters: { approval_class: 'owner_plus_compliance' },
    });

    const engine = createDecisionEngine(fixture);
    const r = await engine.run({ base: mkBase(fixture) });

    expect(r.packet.action_mode).toBe('escalate');
    expect(r.packet.rationale).toContain('owner_plus_compliance');
    expect(r.packet.policy_decisions.some(
      (d) => d.decision === 'require_dual_approval',
    )).toBe(true);
  });

  it('Cenário 5: continue_workflow (active procedure execution matches intent domain)', async () => {
    fixture.setActiveExecution('exec_123');
    fixture.setContent('próximo passo do onboarding');
    // Stub haiku to return onboarding_next_step since heuristic won't match
    (fixture.haiku.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      label: 'onboarding_next_step',
      confidence: 0.85,
    });

    const engine = createDecisionEngine(fixture);
    const r = await engine.run({
      base: mkBase(fixture, { active_procedure_execution_id: 'exec_123' }),
    });

    expect(r.packet.action_mode).toBe('continue_workflow');
    expect(r.packet.routing.workflow_id).toBe('onboard_pf');
  });

  it('Cenário 6: budget fallback (intent classifier blows budget)', async () => {
    let now = 0;
    const env = {
      ...fixture,
      clock: () => now,
      contentResolver: {
        text: async () => {
          now += 500; // exceeds 400ms total
          return 'preciso de algo';
        },
      },
    };
    const engine = createDecisionEngine(env);
    const r = await engine.run({ base: mkBase(fixture) });

    expect(r.fallback_applied).toBe('ask_clarification');
    expect(['ask_clarification', 'escalate']).toContain(r.packet.action_mode);
    expect(fixture.metrics.increment).toHaveBeenCalledWith(
      'decision_engine.budget_fallback',
      expect.objectContaining({ failed_step: expect.any(String) }),
    );
  });

  it('Cenário 7: policy_decisions array populated from 3 PEPs (early warn + mid warn + late warn)', async () => {
    // Early adds a warning policy
    fixture.policies.set('p_early_warn', {
      policy_id: 'p_early_warn',
      descriptor: 'early.warn.something',
      applies_to_peps: ['early'],
    });
    fixture.setVerdict('p_early_warn', {
      action: 'warn_in_trace',
      reason: 'minor early concern',
    });
    // Mid warning via existing rule p_mid_skill_restrict
    fixture.setVerdict('p_mid_skill_restrict', {
      action: 'warn_in_trace',
      reason: 'minor mid concern',
    });
    fixture.setContent('olá!');

    const engine = createDecisionEngine(fixture);
    const r = await engine.run({ base: mkBase(fixture) });

    // Late not run inside DecisionEngine — run it manually to validate appending
    const latePep = new LatePepImpl({
      skillSchemaValidator: {
        validate: async () => ({ valid: true, errors: [] }),
      } satisfies SkillSchemaValidator,
      policyRepo: fixture.policyRepo,
      evaluator: fixture.evaluator,
    });
    fixture.setVerdict('p_late_redact', {
      action: 'warn_in_trace',
      reason: 'minor late style concern',
    });
    const execContext: ExecutionContextPacket = {
      trace_id: r.packet.trace_id,
      skill: { selected_skill: { id: 'skill_greet' } },
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_late_redact',
            rule_descriptor: 'output.pii_redaction',
            applies_to_peps: ['late'],
          },
        ],
      },
    };
    const candidate: AgentOutputCandidate = {
      trace_id: r.packet.trace_id,
      skill_id: 'skill_greet',
      raw_text: 'Olá! Tudo certo por aqui!',
      meta: { model: 'haiku', tokens_used: 20, duration_ms: 50 },
    };
    const lateResult = await latePep.validate(candidate, execContext, r.packet);

    // Merge late entries into the same packet (Guardrails layer responsibility)
    const merged = {
      ...r.packet,
      policy_decisions: [
        ...r.packet.policy_decisions,
        ...lateResult.policy_decisions,
      ],
    };

    const earlyDecisions = merged.policy_decisions.filter((d) => d.pep === 'early');
    const midDecisions = merged.policy_decisions.filter((d) => d.pep === 'mid');
    const lateDecisions = merged.policy_decisions.filter((d) => d.pep === 'late');

    expect(earlyDecisions.length).toBeGreaterThan(0);
    expect(midDecisions.length).toBeGreaterThan(0);
    expect(lateDecisions.length).toBeGreaterThan(0);
  });
});
