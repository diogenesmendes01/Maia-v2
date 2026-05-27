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

  it('F1 Phase 0 — responds (NOT ask_clarification) when no skill selected', async () => {
    // Anti-regression: a turn with no selected skill is a normal free-form chat
    // turn and MUST reach the LLM via `respond`. The old `ask_clarification`
    // here made core.ts send a canned reply and skip the LLM — breaking all
    // free-form chat the moment the engine was enabled.
    const deps = mkDeps();
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({ skill: { selected_skill_id: undefined, candidate_skill_ids: [] } }),
    );
    expect(r.action_mode).toBe('respond');
    expect(r.rationale).toBe('respond:no_skill');
    // No skill lookup should be attempted for a no-skill turn.
    expect(deps.skillsRepo.find).not.toHaveBeenCalled();
  });

  it('F1 Phase 0 — responds even with low intent confidence (no auto ask_clarification)', async () => {
    // A normal chat message frequently classifies below any confidence
    // threshold; it must NOT be hijacked into the canned clarification reply.
    const decider = new ActionDeciderImpl(mkDeps());
    const r = await decider.decide(
      mkInput({
        intent: { label: 'unknown', confidence: 0.3 },
        skill: { selected_skill_id: undefined, candidate_skill_ids: [] },
      }),
    );
    expect(r.action_mode).toBe('respond');
    expect(r.rationale).toBe('respond:no_skill');
  });

  it('F1 Phase 0 — low intent confidence with a FOUND respond skill still responds', async () => {
    // Confidence is no longer a gate in ActionDecider; a selected respond skill
    // routes to `respond` regardless of intent confidence.
    const skill = mkSkill({ id: 'skill_x', category: 'respond' });
    const deps = mkDeps({
      skillsRepo: {
        find: vi.fn().mockResolvedValue(skill),
        findActive: vi.fn().mockResolvedValue([skill]),
      },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({ intent: { label: 'unknown', confidence: 0.3 } }),
    );
    expect(r.action_mode).toBe('respond');
    expect(r.rationale).toBe('respond:skill_x');
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

  it('Codex #103 — enforces reduce_tool_set: removes tools from allowed and moves to blocked', async () => {
    const skill = mkSkill({
      id: 'skill_transfer',
      category: 'tool_mediated',
      allowed_tools: ['transfer_money', 'send_receipt', 'view_balance'],
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
        midPepOutcome: {
          pep: 'mid',
          warnings: [],
          tool_reductions: [
            {
              policy_id: 'p_reduce',
              rule_descriptor: 'transfer.reduce_for_unauth',
              removed_tools: ['transfer_money'],
              reason: 'unauthenticated must not transfer',
            },
          ],
        },
      }),
    );
    expect(r.action_mode).toBe('call_tool');
    // transfer_money was removed from allowed AND moved to blocked
    expect(r.tool_permissions.allowed_tools).not.toContain('transfer_money');
    expect(r.tool_permissions.allowed_tools).toContain('send_receipt');
    expect(r.tool_permissions.allowed_tools).toContain('view_balance');
    expect(r.tool_permissions.blocked_tools).toContain('transfer_money');
    expect(r.tool_permissions.blocked_tools).toContain('delete_account');
    expect(r.tool_permissions.requires_confirmation).not.toContain(
      'transfer_money',
    );
  });

  it('Codex #103 — multiple reductions are accumulated and deduped', async () => {
    const skill = mkSkill({
      id: 'skill_x',
      category: 'tool_mediated',
      allowed_tools: ['t1', 't2', 't3', 't4'],
      blocked_tools: [],
      requires_confirmation_tools: [],
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
        skill: {
          selected_skill_id: 'skill_x',
          candidate_skill_ids: ['skill_x'],
        },
        midPepOutcome: {
          pep: 'mid',
          warnings: [],
          tool_reductions: [
            {
              policy_id: 'p1',
              rule_descriptor: 'd1',
              removed_tools: ['t1', 't2'],
              reason: 'rule 1',
            },
            {
              policy_id: 'p2',
              rule_descriptor: 'd2',
              removed_tools: ['t2', 't3'], // t2 dup
              reason: 'rule 2',
            },
          ],
        },
      }),
    );
    expect(r.tool_permissions.allowed_tools).toEqual(['t4']);
    expect(r.tool_permissions.blocked_tools.sort()).toEqual(['t1', 't2', 't3']);
  });

  it('Codex #103 — falls back to ask_clarification if reduction empties allowed_tools (NEVER auto-allow)', async () => {
    const skill = mkSkill({
      id: 'skill_transfer',
      category: 'tool_mediated',
      allowed_tools: ['transfer_money'],
      blocked_tools: [],
      requires_confirmation_tools: [],
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
        skill: {
          selected_skill_id: 'skill_transfer',
          candidate_skill_ids: ['skill_transfer'],
        },
        midPepOutcome: {
          pep: 'mid',
          warnings: [],
          tool_reductions: [
            {
              policy_id: 'p_reduce',
              rule_descriptor: 'd',
              removed_tools: ['transfer_money'],
              reason: 'all unsafe',
            },
          ],
        },
      }),
    );
    expect(r.action_mode).toBe('ask_clarification');
    expect(r.rationale).toContain('tool_set_reduced_to_empty');
    expect(r.tool_permissions.allowed_tools).toEqual([]);
    expect(r.tool_permissions.blocked_tools).toContain('transfer_money');
  });

  it('Codex round-2 finding 3 — prefers scoped selected_skill over unscoped find()', async () => {
    // SkillSelector already resolved the skill under the routed agent.
    // ActionDecider MUST use that instance instead of re-fetching by ID.
    const scopedSkill: Skill = mkSkill({
      id: 'skill_transfer',
      category: 'tool_mediated',
      allowed_tools: ['transfer_money'],
      blocked_tools: [],
      requires_confirmation_tools: ['transfer_money'],
    });
    // Repo would return a DIFFERENT skill with the same ID (simulating the
    // unscoped-lookup leak). After the fix, this find() must NOT be called.
    const leakingSkill: Skill = mkSkill({
      id: 'skill_transfer',
      category: 'tool_mediated',
      allowed_tools: ['LEAKED_TOOL_FROM_OTHER_AGENT'],
      blocked_tools: [],
      requires_confirmation_tools: [],
    });
    const findSpy = vi.fn().mockResolvedValue(leakingSkill);
    const deps = mkDeps({
      skillsRepo: { find: findSpy, findActive: vi.fn().mockResolvedValue([]) },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({
        intent: { label: 'transfer_intent', confidence: 0.85 },
        skill: {
          selected_skill_id: 'skill_transfer',
          candidate_skill_ids: ['skill_transfer'],
          selected_skill: scopedSkill,
        },
      }),
    );

    expect(r.action_mode).toBe('call_tool');
    // The packet reflects the SCOPED skill's tools — no leak from the repo.
    expect(r.tool_permissions.allowed_tools).toEqual(['transfer_money']);
    expect(r.tool_permissions.allowed_tools).not.toContain(
      'LEAKED_TOOL_FROM_OTHER_AGENT',
    );
    // The unscoped find() was bypassed entirely.
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('Codex round-2 finding 3 — when falling back to find(), passes tenant_id+agent_id scope', async () => {
    // Legacy/test callers may not populate selected_skill. The fallback MUST
    // call find() with the scope tuple so the repo can verify ownership.
    const skill = mkSkill({ id: 'skill_x', category: 'respond' });
    const findSpy = vi.fn().mockResolvedValue(skill);
    const deps = mkDeps({
      skillsRepo: { find: findSpy, findActive: vi.fn().mockResolvedValue([]) },
    });
    const decider = new ActionDeciderImpl(deps);
    await decider.decide(
      mkInput({
        skill: {
          selected_skill_id: 'skill_x',
          candidate_skill_ids: ['skill_x'],
          // selected_skill intentionally omitted — forces fallback
        },
      }),
    );

    expect(findSpy).toHaveBeenCalledTimes(1);
    const args = findSpy.mock.calls[0];
    expect(args?.[0]).toBe('skill_x');
    expect(args?.[1]).toEqual({ tenant_id: 'tn1', agent_id: 'ag1' });
  });

  it('Codex round-2 finding 3 — find() returning null still surfaces as ask_clarification', async () => {
    // Repo enforces ownership check and returns null for cross-agent IDs.
    // ActionDecider must NOT emit empty tool permissions silently.
    const findSpy = vi.fn().mockResolvedValue(null);
    const deps = mkDeps({
      skillsRepo: { find: findSpy, findActive: vi.fn().mockResolvedValue([]) },
    });
    const decider = new ActionDeciderImpl(deps);
    const r = await decider.decide(
      mkInput({
        skill: {
          selected_skill_id: 'skill_other_agent',
          candidate_skill_ids: ['skill_other_agent'],
        },
      }),
    );

    expect(r.action_mode).toBe('ask_clarification');
    expect(r.rationale).toContain('skill_lookup_failed:skill_other_agent');
    expect(r.tool_permissions.allowed_tools).toEqual([]);
  });

  it('Codex #103 — reduce_tool_set is a no-op when removed_tools is empty', async () => {
    const skill = mkSkill({
      id: 'skill_x',
      category: 'tool_mediated',
      allowed_tools: ['t1'],
      blocked_tools: [],
      requires_confirmation_tools: [],
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
        skill: {
          selected_skill_id: 'skill_x',
          candidate_skill_ids: ['skill_x'],
        },
        midPepOutcome: {
          pep: 'mid',
          warnings: [],
          tool_reductions: [
            {
              policy_id: 'p_noop',
              rule_descriptor: 'd',
              removed_tools: [],
              reason: 'evaluator returned empty list',
            },
          ],
        },
      }),
    );
    expect(r.action_mode).toBe('call_tool');
    expect(r.tool_permissions.allowed_tools).toEqual(['t1']);
  });
});
