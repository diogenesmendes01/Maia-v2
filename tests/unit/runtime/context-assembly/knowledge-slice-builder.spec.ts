/**
 * P8a Task 7 — KnowledgeSliceBuilder tests.
 *
 * Critical invariants:
 *   - proposed / pending_review NEVER exposed (master §15 #9).
 *   - entity A facts MUST NOT enter entity B's slice (round-2 finding #1).
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

  // ===========================================================================
  // Round-2 finding #1 — entity scope leak prevention
  // ===========================================================================

  describe('authorized_entity_ids scope isolation', () => {
    /**
     * Entity-scoped fact factory: sets scope='entity' and attaches entity_id.
     */
    const entityFact = (key: string, entityId: string, lifecycle_status = 'active'): FactRecord => ({
      key,
      value: `entity-val-${key}`,
      scope: 'entity',
      entity_id: entityId,
      confidence: 0.9,
      source: 'observation',
      lifecycle_status,
    });

    const tenantFact = (key: string): FactRecord => ({
      key,
      value: `tenant-val-${key}`,
      scope: 'tenant',
      entity_id: null,
      confidence: 0.8,
      source: 'observation',
      lifecycle_status: 'active',
    });

    it('MUST NOT include entity A fact in entity B slice (two-entity isolation)', async () => {
      // Both entity_A and entity_B facts are in the repo response (simulating a
      // query that returned tenant-wide rows before DB-side filtering).
      const entityAFact = entityFact('secret-A', 'entity-A');
      const sharedTenantFact = tenantFact('shared');

      const repo: KnowledgeRepoPort = {
        async listFacts() {
          // Simulates repo returning both facts even though caller only
          // authorized entity-B. The builder's entity filter must remove entity-A.
          return [entityAFact, sharedTenantFact];
        },
        async listRules() {
          return [];
        },
      };

      const builder = new KnowledgeSliceBuilder(repo, cache);

      // Build with entity-B authorized (NOT entity-A).
      const result = await builder.build({
        base: mockBase(),
        requirements: {
          depth: 'relevant',
          authorized_entity_ids: ['entity-B'],
        },
        decision: mockDecision(),
        signal: AbortSignal.timeout(600),
      });

      const keys = result.slice.facts.map((f) => f.key);
      // Entity-A fact must be absent; shared tenant fact must be present.
      expect(keys).not.toContain('secret-A');
      expect(keys).toContain('shared');
    });

    it('entity A fact IS included when entity A is authorized', async () => {
      const entityAFact = entityFact('secret-A', 'entity-A');
      const repo: KnowledgeRepoPort = {
        async listFacts() { return [entityAFact]; },
        async listRules() { return []; },
      };
      const builder = new KnowledgeSliceBuilder(repo, cache);
      const result = await builder.build({
        base: mockBase(),
        requirements: {
          depth: 'relevant',
          authorized_entity_ids: ['entity-A'],
        },
        decision: mockDecision(),
        signal: AbortSignal.timeout(600),
      });
      expect(result.slice.facts.map((f) => f.key)).toContain('secret-A');
    });

    it('empty authorized_entity_ids means no restriction — all facts pass', async () => {
      const eA = entityFact('fa', 'entity-A');
      const eB = entityFact('fb', 'entity-B');
      const repo: KnowledgeRepoPort = {
        async listFacts() { return [eA, eB]; },
        async listRules() { return []; },
      };
      const builder = new KnowledgeSliceBuilder(repo, cache);
      const result = await builder.build({
        base: mockBase(),
        requirements: { depth: 'relevant', authorized_entity_ids: [] },
        decision: mockDecision(),
        signal: AbortSignal.timeout(600),
      });
      const keys = result.slice.facts.map((f) => f.key);
      expect(keys).toContain('fa');
      expect(keys).toContain('fb');
    });

    it('different authorized_entity_ids produce different cache keys', () => {
      const builder = new KnowledgeSliceBuilder(mkRepo([], []), cache);
      const base = mockBase();
      const req = { depth: 'relevant' as const };
      const keyA = builder.cacheKey(base, { ...req, authorized_entity_ids: ['entity-A'] });
      const keyB = builder.cacheKey(base, { ...req, authorized_entity_ids: ['entity-B'] });
      expect(keyA).not.toBe(keyB);
    });
  });
});
