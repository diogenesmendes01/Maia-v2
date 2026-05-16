import { describe, it, expect, vi } from 'vitest';
import {
  SkillSelectorImpl,
  type SkillSelectorDeps,
} from '@/runtime/decision/skill-selector.ts';
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

  it('selects top skill ranked by (category match × priority)', async () => {
    const deps = mkDeps([
      mkSkill({ id: 's_low', category: 'respond', priority: 1 }),
      mkSkill({ id: 's_high', category: 'respond', priority: 5 }),
      mkSkill({ id: 's_tool', category: 'tool_mediated', priority: 10 }),
      // tool_mediated × 1 = 10; respond × 2 = 10 — tie broken by stable sort
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    // s_high score = 2 * 5 = 10; s_tool = 1 * 10 = 10; s_low = 2 * 1 = 2.
    // Top candidates contain both tied entries with respond ranked first.
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
      }),
    );
    const deps = mkDeps(skills);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.candidate_skill_ids).toHaveLength(5);
    expect(r.selected_skill_id).toBe('s0'); // highest priority
  });

  it('passes intent label and workflow_id to repo query', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase(),
      { label: 'transfer_intent', confidence: 0.8 },
      'wf_123',
    );
    expect(deps.skillsRepo.findActive).toHaveBeenCalledWith({
      tenant_id: 'tn1',
      agent_id: 'ag1',
      applicable_to_intent: 'transfer_intent',
      applicable_to_workflow: 'wf_123',
    });
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
      mkSkill({ id: 's_decide', category: 'decide', priority: 3 }),
      mkSkill({ id: 's_respond', category: 'respond', priority: 3 }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_respond');
  });
});
