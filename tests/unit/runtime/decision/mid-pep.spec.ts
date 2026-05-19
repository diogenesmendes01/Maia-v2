import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MidPepImpl, type MidPepDeps } from '@/runtime/decision/mid-pep.ts';
import type {
  BlockDecision,
  ContinueDecision,
  MidPepInput,
  PolicyEvaluator,
  PolicyRulesRepo,
  RequireDualApprovalDecision,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

function mkInput(overrides?: Partial<MidPepInput>): MidPepInput {
  return {
    base: mkBase(),
    intent: { label: 'transfer_intent', confidence: 0.85 },
    risk_profile: {
      level: 'medium',
      reasons: ['high_risk_intent:transfer_intent'],
      requires_human_review: false,
    },
    selected_skill_id: 'skill_transfer',
    candidate_skill_ids: ['skill_transfer'],
    tool_permissions_preview: {
      allowed_tools: [],
      blocked_tools: [],
      requires_confirmation: [],
    },
    resolved_policies: [],
    ...overrides,
  };
}

function mkDeps(overrides?: Partial<MidPepDeps>): MidPepDeps {
  const policyRepo: PolicyRulesRepo = {
    getBody: vi.fn().mockResolvedValue(null),
    getBodySync: vi.fn().mockReturnValue(null),
  };
  const evaluator: PolicyEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'default' }),
  };
  return { policyRepo, evaluator, ...overrides };
}

describe('P9b — Mid PEP', () => {
  beforeEach(() => vi.clearAllMocks());

  it('continues with no warnings when no mid policies apply', async () => {
    const deps = mkDeps();
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(mkInput({ resolved_policies: [] }));
    expect(r.pep).toBe('mid');
    expect('warnings' in r).toBe(true);
    expect((r as ContinueDecision).warnings).toEqual([]);
  });

  it('blocks skill restricted by policy', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_transfer_block',
          descriptor: 'transfer.skill_restricted',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'block',
          reason: 'skill_transfer not allowed for unauthenticated',
          severity: 'high',
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          {
            policy_id: 'p_transfer_block',
            descriptor: 'transfer.skill_restricted',
            applies_to_peps: ['mid'],
          },
        ],
      }),
    );
    const block = r as BlockDecision;
    expect(block.decision).toBe('block');
    expect(block.policy_id).toBe('p_transfer_block');
    expect(block.severity).toBe('high');
  });

  it('escalates when policy returns escalate', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_esc',
          descriptor: 'risk.escalate',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'escalate',
          reason: 'risk too high',
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p_esc', descriptor: 'risk.escalate', applies_to_peps: ['mid'] },
        ],
      }),
    );
    expect((r as BlockDecision).decision).toBe('escalate');
  });

  it('requires dual approval when policy matches', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_dual',
          descriptor: 'transfer.dual_approval',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'require_dual_approval',
          reason: 'amount over limit',
          parameters: { approval_class: 'owner_plus_compliance' },
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          {
            policy_id: 'p_dual',
            descriptor: 'transfer.dual_approval',
            applies_to_peps: ['mid'],
          },
        ],
      }),
    );
    const approval = r as RequireDualApprovalDecision;
    expect(approval.decision).toBe('require_dual_approval');
    expect(approval.approval_class).toBe('owner_plus_compliance');
  });

  it('uses owner_plus_technical as default approval_class', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_dual',
          descriptor: 'd',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'require_dual_approval',
          reason: 'review needed',
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p_dual', descriptor: 'd', applies_to_peps: ['mid'] },
        ],
      }),
    );
    expect((r as RequireDualApprovalDecision).approval_class).toBe(
      'owner_plus_technical',
    );
  });

  it('accumulates warn_in_trace and reduce_tool_set as warnings', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockImplementation(async (id: string) => ({
          policy_id: id,
          descriptor: `d.${id}`,
          applies_to_peps: ['mid'],
        })),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            action: 'warn_in_trace',
            reason: 'minor concern',
          })
          .mockResolvedValueOnce({
            action: 'reduce_tool_set',
            reason: 'removed unsafe tool',
            parameters: { removed_tools: ['delete_account'] },
          }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p1', descriptor: 'd1', applies_to_peps: ['mid'] },
          { policy_id: 'p2', descriptor: 'd2', applies_to_peps: ['mid'] },
        ],
      }),
    );
    const cont = r as ContinueDecision;
    expect(cont.warnings).toHaveLength(2);
    expect(cont.warnings[1]?.reason).toContain('delete_account');
  });

  it('Codex #103 — reduce_tool_set populates structured tool_reductions output', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p_reduce',
          descriptor: 'transfer.reduce_unsafe',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'reduce_tool_set',
          reason: 'remove dangerous tools',
          parameters: { removed_tools: ['transfer_money', 'delete_account'] },
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          {
            policy_id: 'p_reduce',
            descriptor: 'transfer.reduce_unsafe',
            applies_to_peps: ['mid'],
          },
        ],
      }),
    );
    const cont = r as ContinueDecision;
    // Structured reduction available to action-decider
    expect(cont.tool_reductions).toBeDefined();
    expect(cont.tool_reductions).toHaveLength(1);
    expect(cont.tool_reductions?.[0]?.policy_id).toBe('p_reduce');
    expect(cont.tool_reductions?.[0]?.removed_tools).toEqual([
      'transfer_money',
      'delete_account',
    ]);
    // Audit warning still recorded for trace visibility
    expect(cont.warnings).toHaveLength(1);
    expect(cont.warnings[0]?.reason).toContain('transfer_money');
  });

  it('Codex #103 — reduce_tool_set filters non-string entries', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p',
          descriptor: 'd',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'reduce_tool_set',
          reason: 'mix of valid and invalid',
          parameters: {
            removed_tools: ['valid', '', null, 123, 'also_valid'],
          },
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p', descriptor: 'd', applies_to_peps: ['mid'] },
        ],
      }),
    );
    const cont = r as ContinueDecision;
    expect(cont.tool_reductions?.[0]?.removed_tools).toEqual([
      'valid',
      'also_valid',
    ]);
  });

  it('Codex #103 — no tool_reductions key when no reduce_tool_set verdicts fired', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue({
          policy_id: 'p',
          descriptor: 'd',
          applies_to_peps: ['mid'],
        }),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({
          action: 'warn_in_trace',
          reason: 'minor',
        }),
      },
    });
    const pep = new MidPepImpl(deps);
    const r = await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p', descriptor: 'd', applies_to_peps: ['mid'] },
        ],
      }),
    );
    const cont = r as ContinueDecision;
    expect(cont.tool_reductions).toBeUndefined();
    expect(cont.warnings).toHaveLength(1);
  });

  it('skips policies that do not include mid in applies_to_peps', async () => {
    const deps = mkDeps({
      policyRepo: {
        getBody: vi.fn().mockResolvedValue(null),
        getBodySync: vi.fn().mockReturnValue(null),
      },
      evaluator: {
        evaluate: vi.fn().mockResolvedValue({ action: 'allow', reason: 'ok' }),
      },
    });
    const pep = new MidPepImpl(deps);
    await pep.evaluate(
      mkInput({
        resolved_policies: [
          { policy_id: 'p_early', descriptor: 'e', applies_to_peps: ['early'] },
          { policy_id: 'p_late', descriptor: 'l', applies_to_peps: ['late'] },
        ],
      }),
    );
    expect(deps.evaluator.evaluate).not.toHaveBeenCalled();
  });
});
