/**
 * P8a Task 10 — SkillSliceBuilder tests.
 *
 * Mode selection: selected_skill_id present → 'selected_only'; otherwise → 'candidates'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SkillSliceBuilder,
  type SkillRecord,
  type SkillRepoPort,
  type SkillSummary,
} from '@/runtime/context-assembly/slice-builders/skill-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const FULL_SKILL: SkillRecord = {
  id: 'sk1',
  name: 'transfer_money',
  version: 3,
  input_schema_ref: 'schema:transfer:v3:in',
  output_schema_ref: 'schema:transfer:v3:out',
  procedure_ref: 'proc:transfer:v3',
  constraints: { max_amount_brl: 5000 },
  success_criteria: { tipo: 'tool_response' },
  runtime_hints: {
    max_prompt_tokens: 4000,
    max_output_tokens: 800,
    max_tool_calls: 3,
    allow_deep_context: true,
    preferred_model: 'sonnet-4.5',
  },
};

const summary = (id: string, reason: string): SkillSummary => ({
  id,
  name: `name-${id}`,
  reason,
});

const mkRepo = (
  byId: Record<string, SkillRecord | null> = {},
  summaries: SkillSummary[] = [],
): SkillRepoPort => ({
  async getSkillById(_tenant_id, skill_id) {
    return byId[skill_id] ?? null;
  },
  async listSkillSummaries() {
    return summaries;
  },
});

describe('SkillSliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('mode=selected_only loads full skill detail when selected_skill_id present', async () => {
    const builder = new SkillSliceBuilder(mkRepo({ sk1: FULL_SKILL }), cache);
    const decision = mockDecision({
      routing: {
        agent_id: 'agent1',
        candidate_skill_ids: [],
        selected_skill_id: 'sk1',
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: 'selected_only',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.mode).toBe('selected_only');
    expect(r.slice.selected_skill).not.toBeNull();
    expect(r.slice.selected_skill!.id).toBe('sk1');
    expect(r.slice.selected_skill!.runtime_hints.preferred_model).toBe('sonnet-4.5');
    expect(r.slice.candidate_skills).toEqual([]);
  });

  it('mode=candidates loads summarised candidates with reason', async () => {
    const builder = new SkillSliceBuilder(
      mkRepo({}, [
        summary('sk1', 'name match'),
        summary('sk2', 'semantic similarity'),
      ]),
      cache,
    );
    const decision = mockDecision({
      routing: {
        agent_id: 'agent1',
        candidate_skill_ids: ['sk1', 'sk2'],
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: 'candidates',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.mode).toBe('candidates');
    expect(r.slice.selected_skill).toBeNull();
    expect(r.slice.candidate_skills).toHaveLength(2);
    expect(r.slice.candidate_skills[0]!.reason).toBe('name match');
  });

  it('returns null selected_skill when skill_id not found in repo', async () => {
    const builder = new SkillSliceBuilder(mkRepo({}, []), cache);
    const decision = mockDecision({
      routing: {
        agent_id: 'agent1',
        candidate_skill_ids: [],
        selected_skill_id: 'nonexistent',
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: 'selected_only',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.mode).toBe('selected_only');
    expect(r.slice.selected_skill).toBeNull();
  });

  it('falls back to candidates mode when selected_only requested but no selected_skill_id', async () => {
    const builder = new SkillSliceBuilder(
      mkRepo({}, [summary('sk1', 'rank-1')]),
      cache,
    );
    const decision = mockDecision({
      routing: {
        agent_id: 'agent1',
        candidate_skill_ids: ['sk1'],
        // no selected_skill_id
      },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: 'selected_only',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.mode).toBe('candidates');
    expect(r.slice.candidate_skills).toHaveLength(1);
  });

  it('cache hit on second call', async () => {
    const builder = new SkillSliceBuilder(mkRepo({ sk1: FULL_SKILL }), cache);
    const decision = mockDecision({
      routing: { agent_id: 'agent1', candidate_skill_ids: [], selected_skill_id: 'sk1' },
    });
    const a = await builder.build({
      base: mockBase(),
      requirements: 'selected_only',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    const b = await builder.build({
      base: mockBase(),
      requirements: 'selected_only',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(b.cache_hit).toBe(true);
  });

  it('mode=candidates with empty candidate_skill_ids returns empty candidate list', async () => {
    const builder = new SkillSliceBuilder(mkRepo({}, []), cache);
    const decision = mockDecision({
      routing: { agent_id: 'agent1', candidate_skill_ids: [] },
    });
    const r = await builder.build({
      base: mockBase(),
      requirements: 'candidates',
      decision,
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.mode).toBe('candidates');
    expect(r.slice.candidate_skills).toEqual([]);
  });
});
