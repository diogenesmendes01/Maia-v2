import { describe, it, expect } from 'vitest';
import type {
  BlockDecision,
  ContinueDecision,
  EarlyPepInput,
  EarlyPepOutput,
  MidPepOutput,
  PepKind,
  RequireDualApprovalDecision,
} from '@/runtime/decision/types.js';
import { BudgetExhaustedError } from '@/runtime/decision/types.js';
import type {
  BaseContextPacket,
  DecisionPacket,
  PolicyDecision,
} from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

describe('P9b — Decision Engine types', () => {
  it('exports BlockDecision with pep, policy_id, rule_descriptor, decision, reason, severity', () => {
    const sample: BlockDecision = {
      pep: 'early',
      policy_id: 'policy_1',
      rule_descriptor: 'channel.locked_down.global',
      decision: 'block',
      reason: 'channel em lockdown',
      user_facing_message: 'Canal desativado',
      severity: 'high',
    };
    expect(sample.decision).toBe('block');
    expect(sample.pep).toBe('early');
  });

  it('exports ContinueDecision com warnings[]', () => {
    const sample: ContinueDecision = {
      pep: 'early',
      warnings: [{ policy_id: 'p1', rule_descriptor: 'x', reason: 'y' }],
    };
    expect(Array.isArray(sample.warnings)).toBe(true);
    expect(sample.warnings).toHaveLength(1);
  });

  it('exports EarlyPepInput com base + resolved_policies', () => {
    const base: BaseContextPacket = {
      trace_id: 't1',
      tenant_id: 'tn1',
      agent_id: 'ag1',
      channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
      actor: { id: 'a1', is_authenticated: true },
      input: { content_ref: 'cref', received_at: new Date() },
    };
    const input: EarlyPepInput = { base, resolved_policies: [] };
    expect(input.base.trace_id).toBe('t1');
    expect(input.resolved_policies).toEqual([]);
  });

  it('PepKind union includes early, mid, late', () => {
    const peps: PepKind[] = ['early', 'mid', 'late'];
    expect(peps).toContain('late');
  });

  it('DecisionPacket.policy_decisions[].pep can be late', () => {
    const packet: DecisionPacket = {
      trace_id: 't1',
      intent: { label: 'greet', confidence: 0.95 },
      risk_profile: { level: 'low', reasons: [], requires_human_review: false },
      routing: { agent_id: 'ag1', candidate_skill_ids: [] },
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
      policy_decisions: [
        {
          pep: 'late',
          policy_id: 'p_late',
          rule_descriptor: 'output.redaction',
          decision: 'warn',
          reason: 'low-severity',
        },
      ],
      rationale: 'respond:skill_x',
    };
    expect(packet.policy_decisions[0]?.pep).toBe('late');
  });

  it('PolicyDecision union allows allow/block/warn/require_dual_approval/escalate', () => {
    const decisions: PolicyDecision[] = [
      'allow',
      'block',
      'warn',
      'require_dual_approval',
      'escalate',
    ];
    expect(decisions).toHaveLength(5);
  });

  it('RequireDualApprovalDecision is part of MidPepOutput union', () => {
    const decision: RequireDualApprovalDecision = {
      pep: 'mid',
      policy_id: 'p_dual',
      rule_descriptor: 'transfer.requires_dual',
      decision: 'require_dual_approval',
      reason: 'big amount',
      approval_class: 'owner_plus_compliance',
    };
    const asMid: MidPepOutput = decision;
    expect((asMid as RequireDualApprovalDecision).decision).toBe(
      'require_dual_approval',
    );
  });

  it('EarlyPepOutput accepts either Block or Continue', () => {
    const cont: EarlyPepOutput = { pep: 'early', warnings: [] };
    const block: EarlyPepOutput = {
      pep: 'early',
      policy_id: 'p1',
      rule_descriptor: 'd',
      decision: 'block',
      reason: 'r',
      severity: 'medium',
    };
    expect('warnings' in cont).toBe(true);
    expect('decision' in block).toBe(true);
  });

  it('BudgetExhaustedError carries step and elapsed_ms', () => {
    const err = new BudgetExhaustedError('mid_pep', 420);
    expect(err.step).toBe('mid_pep');
    expect(err.elapsed_ms).toBe(420);
    expect(err.name).toBe('BudgetExhaustedError');
    expect(err.message).toContain('mid_pep');
  });
});
