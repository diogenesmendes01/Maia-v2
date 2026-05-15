/**
 * P8a Task 7 — KnowledgeSliceBuilder tests.
 *
 * Critical invariant (master §15 #9): proposed / pending_review NEVER exposed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  KnowledgeSliceBuilder,
  type FactRecord,
  type KnowledgeRepoPort,
  type RuleRecord,
} from '@/runtime/context-assembly/slice-builders/knowledge-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const fact = (key: string, lifecycle_status: string): FactRecord => ({
  key,
  value: `val-${key}`,
  scope: 'tenant',
  confidence: 0.8,
  source: 'observation',
  lifecycle_status,
});

const rule = (id: string, lifecycle_status: string): RuleRecord => ({
  id,
  context: 'ctx',
  action: 'act',
  confidence: 0.8,
  lifecycle_status,
});

const mkRepo = (facts: FactRecord[], rules: RuleRecord[]): KnowledgeRepoPort => ({
  async listFacts() {
    return facts;
  },
  async listRules() {
    return rules;
  },
});

describe('KnowledgeSliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('exposes facts/rules with allowed lifecycle statuses', async () => {
    const facts = [
      fact('f1', 'active'),
      fact('f2', 'verified'),
      fact('f3', 'reinforced'),
      fact('f4', 'observed'),
      fact('f5', 'ephemeral'),
    ];
    const rules = [
      rule('r1', 'active'),
      rule('r2', 'verified'),
    ];
    const builder = new KnowledgeSliceBuilder(mkRepo(facts, rules), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 10, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts).toHaveLength(5);
    expect(r.slice.rules).toHaveLength(2);
  });

  it('NEVER exposes proposed lifecycle status (invariant)', async () => {
    const facts = [
      fact('f1', 'active'),
      fact('f2', 'proposed'),
      fact('f3', 'verified'),
    ];
    const rules = [
      rule('r1', 'proposed'),
      rule('r2', 'active'),
    ];
    const builder = new KnowledgeSliceBuilder(mkRepo(facts, rules), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 10, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts.map((f) => f.key)).toEqual(['f1', 'f3']);
    expect(r.slice.rules.map((r2) => r2.id)).toEqual(['r2']);
    expect(r.slice.facts.every((f) => f.lifecycle_status !== ('proposed' as never))).toBe(true);
  });

  it('NEVER exposes pending_review lifecycle status (invariant)', async () => {
    const facts = [
      fact('f1', 'pending_review'),
      fact('f2', 'active'),
    ];
    const rules = [rule('r1', 'pending_review')];
    const builder = new KnowledgeSliceBuilder(mkRepo(facts, rules), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 10, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts.map((f) => f.key)).toEqual(['f2']);
    expect(r.slice.rules).toEqual([]);
  });

  it('drops any lifecycle status not in the allowlist', async () => {
    const facts = [
      fact('f1', 'archived'),
      fact('f2', 'draft'),
      fact('f3', 'active'),
    ];
    const builder = new KnowledgeSliceBuilder(mkRepo(facts, []), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 10, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts.map((f) => f.key)).toEqual(['f3']);
  });

  it('truncates facts and sets truncated.facts=true', async () => {
    const facts = Array.from({ length: 15 }, (_, i) => fact(`f${i}`, 'active'));
    const builder = new KnowledgeSliceBuilder(mkRepo(facts, []), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 5, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts).toHaveLength(5);
    expect(r.slice.truncated.facts).toBe(true);
    expect(r.slice.truncated.rules).toBe(false);
  });

  it('depth=none returns empty slice', async () => {
    const builder = new KnowledgeSliceBuilder(mkRepo([fact('f1', 'active')], []), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'none' },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.facts).toEqual([]);
    expect(r.slice.rules).toEqual([]);
  });

  it('cache hit on second call', async () => {
    const builder = new KnowledgeSliceBuilder(
      mkRepo([fact('f1', 'active')], [rule('r1', 'active')]),
      cache,
    );
    const a = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 5, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    const b = await builder.build({
      base: mockBase(),
      requirements: { depth: 'relevant', max_facts: 5, max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(b.cache_hit).toBe(true);
  });
});
