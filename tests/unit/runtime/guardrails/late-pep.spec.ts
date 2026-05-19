import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LatePepImpl } from '@/runtime/guardrails/late-pep.ts';
import type {
  AgentOutputCandidate,
  ExecutionContextPacket,
  LatePepDeps,
  PolicyValidationResult,
  SkillSchemaValidator,
} from '@/runtime/guardrails/types.js';
import type {
  PolicyEvaluator,
  PolicyRulesRepo,
} from '@/runtime/decision/types.js';
import type { DecisionPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

function mkDeps(overrides?: Partial<LatePepDeps>): LatePepDeps {
  const skillSchemaValidator: SkillSchemaValidator = {
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  };
  const policyRepo: PolicyRulesRepo = {
    getBody: vi.fn().mockResolvedValue(null),
    getBodySync: vi.fn().mockReturnValue(null),
  };
  const evaluator: PolicyEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'default' }),
  };
  return { skillSchemaValidator, policyRepo, evaluator, ...overrides };
}

function mkCandidate(overrides?: Partial<AgentOutputCandidate>): AgentOutputCandidate {
  return {
    trace_id: 't1',
    skill_id: 'skill_respond',
    raw_text: 'Seu saldo é R$ 1000',
    meta: { model: 'haiku', tokens_used: 50, duration_ms: 100 },
    ...overrides,
  };
}

function mkExecContext(
  overrides?: Partial<ExecutionContextPacket>,
): ExecutionContextPacket {
  return {
    trace_id: 't1',
    skill: { selected_skill: { id: 'skill_respond' } },
    policy: { applicable_rules: [] },
    ...overrides,
  };
}

function mkDecision(): DecisionPacket {
  return {
    trace_id: 't1',
    intent: { label: 'greet', confidence: 0.95 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: {
      agent_id: 'ag1',
      candidate_skill_ids: ['skill_respond'],
      selected_skill_id: 'skill_respond',
    },
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
    policy_decisions: [],
    rationale: 'respond:skill_respond',
  };
}

describe('P9b — Late PEP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes valid output with no late policies (final_action=send)', async () => {
    const deps = mkDeps();
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), mkExecContext(), mkDecision());
    expect(r.passed).toBe(true);
    expect(r.final_action).toBe('send');
    expect(r.policy_decisions).toEqual([]);
  });

  it('returns regenerate when schema validation fails', async () => {
    const deps = mkDeps({
      skillSchemaValidator: {
        validate: vi.fn().mockResolvedValue({
          valid: false,
          errors: ['field "amount" required', 'invalid currency'],
        }),
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(
      mkCandidate(),
      mkExecContext({
        skill: {
          selected_skill: {
            id: 'skill_x',
            output_schema_ref: 'schema_v1',
          },
        },
      }),
      mkDecision(),
    );
    expect(r.passed).toBe(false);
    expect(r.final_action).toBe('regenerate');
    expect(r.policy_decisions[0]?.decision).toBe('block');
    expect(r.policy_decisions[0]?.reason).toContain('field "amount" required');
  });

  it('blocks when late policy returns block', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_redact',
          descriptor: 'output.pii_redaction',
          applies_to_peps: ['late'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'block',
          reason: 'PII leak detected',
          severity: 'critical',
        }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_redact',
            rule_descriptor: 'output.pii_redaction',
            applies_to_peps: ['late'],
          },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), exec, mkDecision());
    expect(r.passed).toBe(false);
    expect(r.final_action).toBe('block');
    expect(r.policy_decisions).toHaveLength(1);
    expect(r.policy_decisions[0]?.decision).toBe('block');
  });

  it('escalates when late policy returns escalate', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_esc',
          descriptor: 'output.escalate',
          applies_to_peps: ['late'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'escalate',
          reason: 'review needed',
        }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_esc',
            rule_descriptor: 'output.escalate',
            applies_to_peps: ['late'],
          },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r: PolicyValidationResult = await pep.validate(
      mkCandidate(),
      exec,
      mkDecision(),
    );
    expect(r.final_action).toBe('escalate');
  });

  it('records warnings (warn_in_trace) without blocking', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_warn',
          descriptor: 'output.style.warn',
          applies_to_peps: ['late'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'warn_in_trace',
          reason: 'tone slightly off',
        }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_warn',
            rule_descriptor: 'output.style.warn',
            applies_to_peps: ['late'],
          },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), exec, mkDecision());
    expect(r.passed).toBe(true);
    expect(r.final_action).toBe('send');
    expect(r.policy_decisions).toHaveLength(1);
    expect(r.policy_decisions[0]?.decision).toBe('warn');
  });

  it('skips non-late policies', async () => {
    const deps = mkDeps({
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_early',
            rule_descriptor: 'd_early',
            applies_to_peps: ['early'],
          },
          {
            policy_id: 'p_mid',
            rule_descriptor: 'd_mid',
            applies_to_peps: ['mid'],
          },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    await pep.validate(mkCandidate(), exec, mkDecision());
    expect(deps.evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('Codex round-2 finding 1 — require_dual_approval verdict halts send and escalates', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_dual_late',
          descriptor: 'output.requires_dual_approval',
          applies_to_peps: ['late'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'require_dual_approval',
          reason: 'output crosses dual-approval threshold',
          parameters: { approval_class: 'owner_plus_compliance' },
        }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          {
            policy_id: 'p_dual_late',
            rule_descriptor: 'output.requires_dual_approval',
            applies_to_peps: ['late'],
          },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), exec, mkDecision());

    // The critical bug: before the fix the verdict was recorded but the loop
    // fell through to passed:true / final_action:'send'. After the fix,
    // dual_approval verdicts MUST block the send path with escalate.
    expect(r.passed).toBe(false);
    expect(r.final_action).toBe('escalate');
    expect(r.policy_decisions).toHaveLength(1);
    expect(r.policy_decisions[0]?.decision).toBe('require_dual_approval');
    expect(r.policy_decisions[0]?.policy_id).toBe('p_dual_late');
  });

  it('Codex round-2 finding 1 — first dual_approval halts further policy evaluation', async () => {
    // Two late policies in sequence — first returns dual_approval, second
    // would return allow. After the fix the second one must NOT be reached.
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        action: 'require_dual_approval',
        reason: 'amount over threshold',
      })
      .mockResolvedValueOnce({ action: 'allow', reason: 'ok' });
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockImplementation(async (id: string) => ({
          policy_id: id,
          descriptor: `d.${id}`,
          applies_to_peps: ['late'],
        })),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: { evaluate },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          { policy_id: 'p_dual', rule_descriptor: 'd_dual', applies_to_peps: ['late'] },
          { policy_id: 'p_allow', rule_descriptor: 'd_allow', applies_to_peps: ['late'] },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), exec, mkDecision());

    expect(r.passed).toBe(false);
    expect(r.final_action).toBe('escalate');
    // Only the first policy was evaluated (loop short-circuited).
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(r.policy_decisions).toHaveLength(1);
  });

  it('all policy_decisions have pep=late', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockImplementation(async (id: string) => ({
          policy_id: id,
          descriptor: `d.${id}`,
          applies_to_peps: ['late'],
        })),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ action: 'allow', reason: 'ok' })
          .mockResolvedValueOnce({ action: 'warn_in_trace', reason: 'minor' }),
      },
    });
    const exec = mkExecContext({
      policy: {
        applicable_rules: [
          { policy_id: 'p1', rule_descriptor: 'd1', applies_to_peps: ['late'] },
          { policy_id: 'p2', rule_descriptor: 'd2', applies_to_peps: ['late'] },
        ],
      },
    });
    const pep = new LatePepImpl(deps);
    const r = await pep.validate(mkCandidate(), exec, mkDecision());
    expect(r.policy_decisions.every((d) => d.pep === 'late')).toBe(true);
  });
});
