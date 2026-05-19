/**
 * P8a Task 9 — PolicySliceBuilder tests.
 *
 * Critical invariant (master §3.8): hard_limit rules MUST be preserved
 * regardless of max_rules budget.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PolicySliceBuilder,
  stubPolicyDescriptorResolver,
  type PolicyDescriptorResolverPort,
  type PolicyRuleRecord,
} from '@/runtime/context-assembly/slice-builders/policy-slice-builder.js';
import { InMemorySliceCache } from '@/runtime/context-packet/cache/slice-cache.js';
import { mockBase, mockDecision } from './_fixture.js';

const rule = (
  policy_id: string,
  rule_kind: PolicyRuleRecord['rule_kind'],
  overrides?: Partial<PolicyRuleRecord>,
): PolicyRuleRecord => ({
  policy_id,
  version: 1,
  rule_descriptor: `desc-${policy_id}`,
  rule_kind,
  applies_to_peps: ['early'],
  rule_body_ref: `ref-${policy_id}`,
  ...overrides,
});

const mkResolver = (
  rules: PolicyRuleRecord[],
): PolicyDescriptorResolverPort => ({
  async resolveDescriptors() {
    return { resolved: rules, unresolved: [] };
  },
});

describe('PolicySliceBuilder', () => {
  let cache: InMemorySliceCache;
  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('preserves ALL hard_limit rules even when budget is tight', async () => {
    const rules: PolicyRuleRecord[] = [
      rule('p1', 'hard_limit'),
      rule('p2', 'hard_limit'),
      rule('p3', 'hard_limit'),
      rule('p4', 'hard_limit'),
      rule('p5', 'hard_limit'),
      rule('p6', 'soft_guidance'),
      rule('p7', 'soft_guidance'),
      rule('p8', 'soft_guidance'),
    ];
    const builder = new PolicySliceBuilder(mkResolver(rules), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 6 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    // 5 hard_limits + 1 soft = 6 total, but ALL 5 hard_limits must be there
    const hards = r.slice.applicable_rules.filter(
      (rr) => rr.rule_kind === 'hard_limit',
    );
    expect(hards).toHaveLength(5);
    expect(r.slice.applicable_rules).toHaveLength(6);
    expect(r.slice.truncated).toBe(true);
  });

  it('handles tighter budget: 5 hard_limits + max_rules=3 still includes all 5', async () => {
    const rules: PolicyRuleRecord[] = [
      rule('p1', 'hard_limit'),
      rule('p2', 'hard_limit'),
      rule('p3', 'hard_limit'),
      rule('p4', 'hard_limit'),
      rule('p5', 'hard_limit'),
      rule('p6', 'soft_guidance'),
    ];
    const builder = new PolicySliceBuilder(mkResolver(rules), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 3 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    // Even when max=3, hard_limits override budget — all 5 stay.
    expect(
      r.slice.applicable_rules.filter((rr) => rr.rule_kind === 'hard_limit'),
    ).toHaveLength(5);
    // No room for soft, so soft is excluded
    expect(r.slice.applicable_rules.filter((rr) => rr.rule_kind === 'soft_guidance')).toHaveLength(0);
  });

  it('returns empty slice when resolver has no rules', async () => {
    const builder = new PolicySliceBuilder(mkResolver([]), cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 20 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.applicable_rules).toEqual([]);
    expect(r.slice.truncated).toBe(false);
  });

  it('cache hit on second call', async () => {
    const builder = new PolicySliceBuilder(
      mkResolver([rule('p1', 'hard_limit')]),
      cache,
    );
    const a = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(a.cache_hit).toBe(false);
    const b = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(b.cache_hit).toBe(true);
  });

  it('cache key changes when depth changes (scope filter)', () => {
    const builder = new PolicySliceBuilder(mkResolver([]), cache);
    const base = mockBase();
    expect(builder.cacheKey(base, { depth: 'basic' })).not.toBe(
      builder.cacheKey(base, { depth: 'risk' }),
    );
  });

  it('P8e stub resolver returns empty rules (placeholder)', async () => {
    const builder = new PolicySliceBuilder(stubPolicyDescriptorResolver, cache);
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 20 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    expect(r.slice.applicable_rules).toEqual([]);
    expect(r.slice.truncated).toBe(false);
  });

  it('resolver_cache_key matches the cache key used to store the slice', async () => {
    const builder = new PolicySliceBuilder(
      mkResolver([rule('p1', 'hard_limit')]),
      cache,
    );
    const r = await builder.build({
      base: mockBase(),
      requirements: { depth: 'basic', max_rules: 5 },
      decision: mockDecision(),
      signal: AbortSignal.timeout(600),
    });
    const expected = builder.cacheKey(mockBase(), {
      depth: 'basic',
      max_rules: 5,
    });
    expect(r.slice.resolver_cache_key).toBe(expected);
  });
});
