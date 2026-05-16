import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ActionDeciderImpl,
  type ActionDeciderDeps,
} from '@/runtime/decision/action-decider.ts';
import type {
  ActionDeciderInput,
  RequireDualApprovalDecision,
  Skill,
  SkillsRepo,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
  };
}

function mkDeps(overrides?: Partial<ActionDeciderDeps>): ActionDeciderDeps {
  const skillsRepo: SkillsRepo = {
    findActive: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(null),
  };
  return { skillsRepo, ...overrides };
}

function mkInput(overrides?: Partial<ActionDeciderInput>): ActionDeciderInput {
  return {
    base: mkBase(),
    intent: { label: 'greet', confidence: 0.95 },
    risk: { level: 'low', reasons: [], requires_human_review: false },
    workflow: { mode: 'none' },
    skill: { selected_skill_id: 'skill_x', candidate_skill_ids: ['skill_x'] },
    midPepOutcome: { pep: 'mid', warnings: [] },
    earlyWarnings: [],
    ...overrides,
  };
}

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill => ({
  category: 'respond',
  priority: 1,
  status: 'active',
  ...overrides,
});

describe('P9b — ActionDecider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('responds for low-risk intent + respond skill available', async () => {
    const skill = mkSkill({ id: 'skill_x', category: 'respond' });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(mkInput());
    expect(r.action_mode).toBe('respond');
    expect(r.rationale).toBe('respond:skill_x');
  });

  it('escalates when require_dual_approval', async () => {
    const decider = new ActionDeciderImpl(mkDeps());
    const dual: RequireDualApprovalDecision = {
      pep: 'mid',
      policy_id: 'p_dual',
      rule_descriptor: 'd',
      decision: 'require_dual_approval',
      reason: 'big',
      approval_class: 'owner_plus_compliance',
    };
    const r = await decider.decide(mkInput({ midPepOutcome: dual }));
    expect(r.action_mode).toBe('escalate');
    expect(r.rationale).toContain('owner_plus_compliance');
    expect(r.evaluation_plan.human_review_required).toBe(true);
  });

  it('escalates when risk.requires_human_review=true', async () => {
    const decider = new ActionDeciderImpl(mkDeps());
    const r = await decider.decide(
      mkInput({
        risk: { level: 'high', reasons: ['fraud_signals'], requires_human_review: true },
      }),
    );
    expect(r.action_mode).toBe('escalate');
    expect(r.rationale).toContain('human_review_required');
  });

  it('continues workflow when workflow.mode=continue with id', async () => {
    const decider = new ActionDeciderImpl(mkDeps());
    const r = await decider.decide(
      mkInput({ workflow: { mode: 'continue', workflow_id: 'wf_123' } }),
    );
    expect(r.action_mode).toBe('continue_workflow');
    expect(r.rationale).toContain('wf_123');
  });

  it('asks clarification when no skill selected', async () => {
    const decider = new ActionDeciderImpl(mkDeps());
    const r = await decider.decide(
      mkInput({ skill: { selected_skill_id: undefined, candidate_skill_ids: [] } }),
    );
    expect(r.action_mode).toBe('ask_clarification');
    expect(r.rationale).toBe('skill_missing');
  });

  it('asks clarification when intent confidence below threshold', async () => {
    const decider = new ActionDeciderImpl(mkDeps());
    const r = await decider.decide(
      mkInput({ intent: { label: 'unknown', confidence: 0.3 } }),
    );
    expect(r.action_mode).toBe('ask_clarification');
    expect(r.rationale).toContain('low_intent_confidence');
  });

  it('calls tool when skill.category=tool_mediated', async () => {
    const skill = mkSkill({
      id: 'skill_transfer',
      category: 'tool_mediated',
      allowed_tools: ['transfer_money', 'send_receipt'],
      blocked_tools: ['delete_account'],
      requires_confirmation_tools: ['transfer_money'],
    });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({
        intent: { label: 'transfer_intent', confidence: 0.85 },
        skill: {
          selected_skill_id: 'skill_transfer',
          candidate_skill_ids: ['skill_transfer'],
        },
      }),
    );
    expect(r.action_mode).toBe('call_tool');
    expect(r.tool_permissions.allowed_tools).toContain('transfer_money');
    expect(r.tool_permissions.blocked_tools).toContain('delete_account');
    expect(r.tool_permissions.requires_confirmation).toContain('transfer_money');
  });

  it('calls tool when skill.category=decide', async () => {
    const skill = mkSkill({ id: 'skill_decide', category: 'decide' });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({
        skill: {
          selected_skill_id: 'skill_decide',
          candidate_skill_ids: ['skill_decide'],
        },
      }),
    );
    expect(r.action_mode).toBe('call_tool');
  });

  it('falls back to ask_clarification when skill lookup returns null', async () => {
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(null),
        findActive: vi.fn().mockResolvedValue([]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(mkInput());
    expect(r.action_mode).toBe('ask_clarification');
    expect(r.rationale).toContain('skill_lookup_failed');
  });

  it('uses deep context_requirements when risk.level=medium', async () => {
    const skill = mkSkill({ id: 'skill_x' });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({
        risk: { level: 'medium', reasons: ['x'], requires_human_review: false },
      }),
    );
    expect(r.context_requirements.user.depth).toBe('deep');
    expect(r.context_requirements.knowledge.depth).toBe('deep');
  });

  it('uses default context_requirements when intent is generic + low risk', async () => {
    const skill = mkSkill({ id: 'skill_x' });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(mkInput());
    expect(r.context_requirements.user.depth).toBe('minimal');
  });
});
