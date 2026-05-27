import { describe, it, expect, vi } from 'vitest';
import {
  SkillSelectorImpl,
  type SkillSelectorDeps,
} from '@/runtime/decision/skill-selector.ts';
import { SKILL_MATCH_THRESHOLD } from '@/runtime/decision/skill-match.ts';
import type { SkillsRepo, Skill } from '@/runtime/decision/types.js';
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

function mkDeps(skills: Skill[]): SkillSelectorDeps {
  const skillsRepo: SkillsRepo = {
    findActive: vi.fn().mockResolvedValue(skills),
    find: vi.fn().mockResolvedValue(null),
  };
  return { skillsRepo };
}

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill => ({
  category: 'respond',
  priority: 1,
  status: 'active',
  ...overrides,
});

describe('P9b — SkillSelector', () => {
  it('returns empty when no skills found', async () => {
    const deps = mkDeps([]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'unknown',
      confidence: 0.2,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual([]);
  });

  it('selects top matching skill ranked by (category match × priority)', async () => {
    // All three declare the intent; selection then prefers the best
    // category×priority among the matches.
    const deps = mkDeps([
      mkSkill({
        id: 's_low',
        category: 'respond',
        priority: 1,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_high',
        category: 'respond',
        priority: 5,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_tool',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['balance_query'],
      }),
      // tool_mediated × 1 = 10; respond × 2 = 10 — tie broken by stable sort
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.candidate_skill_ids).toContain('s_high');
    expect(r.candidate_skill_ids).toContain('s_tool');
    expect(r.selected_skill_id).toBeDefined();
  });

  it('limits candidate_skill_ids to top 5', async () => {
    const skills: Skill[] = Array.from({ length: 8 }, (_, i) =>
      mkSkill({
        id: `s${i}`,
        category: 'respond',
        priority: 10 - i,
        applicable_to_intent: ['balance_query'],
      }),
    );
    const deps = mkDeps(skills);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.candidate_skill_ids).toHaveLength(5);
    expect(r.selected_skill_id).toBe('s0'); // highest priority among matches
  });

  it('passes intent label and workflow_id to repo query', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase(),
      { label: 'transfer_intent', confidence: 0.8 },
      { workflow_id: 'wf_123' },
    );
    // Round-2 finding 4: findActive now accepts a second arg for AbortSignal
    // propagation, so match the first arg precisely and tolerate the rest.
    expect(deps.skillsRepo.findActive).toHaveBeenCalledWith(
      {
        tenant_id: 'tn1',
        agent_id: 'ag1',
        applicable_to_intent: 'transfer_intent',
        applicable_to_workflow: 'wf_123',
      },
      expect.any(Object),
    );
  });

  it('Codex #103 — uses agent_id_override when provided (routed agent ≠ base agent)', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase({ agent_id: 'base_agent_X' }),
      { label: 'transfer_intent', confidence: 0.8 },
      { agent_id_override: 'routed_agent_Y' },
    );
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call?.agent_id).toBe('routed_agent_Y');
    expect(call?.agent_id).not.toBe('base_agent_X');
  });

  it('Codex #103 — falls back to base.agent_id when no override given', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase({ agent_id: 'base_only' }),
      { label: 'greet', confidence: 0.95 },
    );
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call?.agent_id).toBe('base_only');
  });

  it('omits workflow_id from query when undefined', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(mkBase(), { label: 'greet', confidence: 0.95 });
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call).toEqual({
      tenant_id: 'tn1',
      agent_id: 'ag1',
      applicable_to_intent: 'greet',
    });
  });

  it('ranks respond category higher than other categories at equal priority', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_decide',
        category: 'decide',
        priority: 3,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_respond',
        category: 'respond',
        priority: 3,
        applicable_to_intent: ['balance_query'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_respond');
  });

  // ---------------------------------------------------------------------------
  // F1 Phase 0 — anti-hijack intent matching
  // ---------------------------------------------------------------------------

  it('F1 Phase 0 — returns EMPTY selection when an active skill does NOT match the message', async () => {
    // The anti-hijack guard: an active billing skill must NOT be selected for
    // an unrelated greeting. Candidates are still listed, but nothing is
    // committed, so ActionDecider routes the turn to a normal `respond`.
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['billing_question', 'cancel_subscription'],
        when_to_use: 'When the customer asks about invoices or billing charges.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'greet',
      confidence: 0.95,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.selected_skill).toBeUndefined();
    // Candidate list still reflects what was in scope.
    expect(r.candidate_skill_ids).toEqual(['s_billing']);
  });

  it('F1 Phase 0 — selects a skill whose applicable_to_intent matches exactly', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['billing_question'],
        when_to_use: 'When the customer asks about invoices.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'billing_question',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBe('s_billing');
    expect(r.selected_skill?.id).toBe('s_billing');
  });

  it('F1 Phase 0 — selects a skill whose when_to_use clearly overlaps the intent tokens', async () => {
    // No applicable_to_intent declared; selection relies on token overlap with
    // when_to_use. intent tokens {transfer, money} both appear → ratio 1.0.
    const deps = mkDeps([
      mkSkill({
        id: 's_transfer',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to transfer money between accounts.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'transfer_money',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBe('s_transfer');
  });

  it('F1 Phase 0 — does NOT select on a single weak token overlap below threshold', async () => {
    // intent tokens {schedule, payment, reminder}; only "payment" overlaps →
    // ratio 1/3 ≈ 0.33 < threshold (0.5). Ambiguous ⇒ no selection.
    const deps = mkDeps([
      mkSkill({
        id: 's_pay',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to process a payment immediately.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'schedule_payment_reminder',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBeUndefined();
  });

  it('F1 Phase 0 — picks the BEST match, not the highest-ranked irrelevant skill', async () => {
    // High-priority skill is irrelevant to the turn; a lower-priority skill
    // matches. The matcher must win over raw category×priority ranking.
    const deps = mkDeps([
      mkSkill({
        id: 's_irrelevant_high',
        category: 'respond',
        priority: 100,
        applicable_to_intent: ['complaint'],
        when_to_use: 'When the user files a complaint.',
      }),
      mkSkill({
        id: 's_relevant_low',
        category: 'tool_mediated',
        priority: 1,
        applicable_to_intent: ['balance_query'],
        when_to_use: 'When the user asks for their balance.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_relevant_low');
  });

  it('F1 Phase 0 — never selects when intent label is unknown, even with active skills', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_any',
        category: 'respond',
        priority: 10,
        applicable_to_intent: ['greet'],
        when_to_use: 'A generic responder.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'unknown',
      confidence: 0.9, // even high confidence on an unknown label must not select
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual(['s_any']);
  });

  it('F1 Phase 0 — exposes a sane match threshold constant', () => {
    expect(SKILL_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(SKILL_MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
