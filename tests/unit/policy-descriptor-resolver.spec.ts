/**
 * P8e Task 9 — unit tests for PolicyDescriptorResolver.
 *
 * Spec §8.1. Validates:
 *   - resolved/unresolved correctness for single + mixed descriptor lists
 *   - invariant: resolved.length + unresolved.length === input.descriptors.length
 *   - scope filter (rule scope vs input scope)
 *   - agent-specific override (agent_id-specific row beats tenant-wide)
 *   - cache hit on second consecutive call
 *
 * Resolver is exercised via createPolicyDescriptorResolver(mockRepo, cache).
 * The cache is the real PolicyResolverCacheImpl with TTL = 60s.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPolicyDescriptorResolver,
  PolicyResolverCacheImpl,
  matchesScope,
  hasBlockingFailure,
  RESOLVER_FAILURE_DEFAULT,
  type PolicyResolverCache,
} from '@/control-plane/policy/index.js';
import type {
  PolicyRule,
  PolicyRulesRepo,
} from '@/control-plane/policy/index.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * In-memory repo fake. Tests configure rows in `state`; the resolver calls
 * findActiveByDescriptor against this.
 */
function makeFakeRepo(rows: PolicyRule[]): {
  repo: PolicyRulesRepo;
  calls: { findActiveByDescriptor: number };
} {
  const calls = { findActiveByDescriptor: 0 };
  const repo: PolicyRulesRepo = {
    async findActiveByDescriptor(args) {
      calls.findActiveByDescriptor++;
      // Agent-specific first
      if (args.agent_id) {
        const a = rows.find(
          (r) =>
            r.rule_descriptor === args.descriptor &&
            r.agent_id === args.agent_id &&
            r.status === 'active',
        );
        if (a) return a;
      }
      // Tenant-wide fallback
      const t = rows.find(
        (r) =>
          r.rule_descriptor === args.descriptor &&
          r.agent_id === null &&
          r.status === 'active',
      );
      return t ?? null;
    },
    async listActiveForTenant() {
      return rows.filter((r) => r.status === 'active');
    },
    async listVersions() {
      return [];
    },
    async getById() {
      return null;
    },
    async propose() {
      throw new Error('not used in resolver test');
    },
    async activate() {
      return { ok: false, reason: 'not_found' };
    },
    async deprecate() {
      return { ok: false, reason: 'not_found' };
    },
    async rollback() {
      return { ok: false, reason: 'not_found' };
    },
    async nextVersion() {
      return 1;
    },
  };
  return { repo, calls };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: `pol-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'default',
    agent_id: null,
    rule_kind: 'soft_guidance',
    rule_descriptor: 'desc_a',
    rule_body: {},
    scope: {},
    source_of_truth: 'founder_explicit',
    status: 'active',
    version: 1,
    proposed_by: 'test',
    proposed_reason: null,
    approved_by: 'test',
    approved_at: new Date(),
    activated_at: new Date(),
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

let cache: PolicyResolverCache;
beforeEach(() => {
  cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
});

describe('PolicyDescriptorResolver.resolveDescriptors', () => {
  it('resolves a single known descriptor', async () => {
    const rule = makeRule({ rule_descriptor: 'known' });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['known'],
    });

    expect(out.resolved).toHaveLength(1);
    expect(out.unresolved).toHaveLength(0);
    expect(out.resolved[0]).toMatchObject({
      descriptor: 'known',
      policy_id: rule.id,
      version: 1,
      rule_kind: 'soft_guidance',
    });
  });

  it('puts unknown descriptors in unresolved with empty resolved', async () => {
    const { repo } = makeFakeRepo([]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['unknown'],
    });

    expect(out.resolved).toHaveLength(0);
    expect(out.unresolved).toEqual(['unknown']);
  });

  it('mixes resolved + unresolved correctly preserving order', async () => {
    const rA = makeRule({ rule_descriptor: 'a' });
    const rC = makeRule({ rule_descriptor: 'c' });
    const { repo } = makeFakeRepo([rA, rC]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['a', 'b', 'c', 'd'],
    });

    expect(out.resolved.map((r) => r.descriptor)).toEqual(['a', 'c']);
    expect(out.unresolved).toEqual(['b', 'd']);
    // Invariant master §5.2: resolved + unresolved = input.descriptors.length
    expect(out.resolved.length + out.unresolved.length).toBe(4);
  });

  it('returns empty buckets for empty input', async () => {
    const { repo } = makeFakeRepo([]);
    const resolver = createPolicyDescriptorResolver(repo, cache);
    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: [],
    });
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it('agent-specific rule overrides tenant-wide for same descriptor', async () => {
    const wide = makeRule({
      rule_descriptor: 'shared',
      agent_id: null,
      version: 1,
    });
    const specific = makeRule({
      rule_descriptor: 'shared',
      agent_id: 'agent-x',
      version: 5,
    });
    const { repo } = makeFakeRepo([wide, specific]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      agent_id: 'agent-x',
      descriptors: ['shared'],
    });

    expect(out.resolved[0]?.policy_id).toBe(specific.id);
    expect(out.resolved[0]?.version).toBe(5);
  });

  it('falls back to tenant-wide when agent has no specific rule', async () => {
    const wide = makeRule({
      rule_descriptor: 'shared',
      agent_id: null,
      version: 1,
    });
    const { repo } = makeFakeRepo([wide]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      agent_id: 'agent-x',
      descriptors: ['shared'],
    });

    expect(out.resolved[0]?.policy_id).toBe(wide.id);
  });

  it('scope filter: rule scope {channel:whatsapp} matches input {channel:whatsapp}', async () => {
    const rule = makeRule({
      rule_descriptor: 'scoped',
      scope: { channel: 'whatsapp' },
    });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['scoped'],
      scope: { channel: 'whatsapp' },
    });

    expect(out.resolved).toHaveLength(1);
    expect(out.unresolved).toHaveLength(0);
  });

  it('scope filter: rule scope {channel:whatsapp} does not match input {channel:telegram}', async () => {
    const rule = makeRule({
      rule_descriptor: 'scoped',
      scope: { channel: 'whatsapp' },
    });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['scoped'],
      scope: { channel: 'telegram' },
    });

    expect(out.resolved).toHaveLength(0);
    expect(out.unresolved).toEqual(['scoped']);
  });

  it('scope filter: empty rule.scope is universal (matches any input.scope)', async () => {
    const rule = makeRule({ rule_descriptor: 'universal', scope: {} });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['universal'],
      scope: { channel: 'anything' },
    });

    expect(out.resolved).toHaveLength(1);
  });

  it('second consecutive call hits the cache (does not re-query repo)', async () => {
    const rule = makeRule({ rule_descriptor: 'cached' });
    const { repo, calls } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['cached'],
    });
    expect(calls.findActiveByDescriptor).toBe(1);

    await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['cached'],
    });
    expect(calls.findActiveByDescriptor).toBe(1); // still 1
    expect(cache.stats().hits).toBeGreaterThanOrEqual(1);
  });

  it('caches "unresolved" so repeated miss does not re-query repo', async () => {
    const { repo, calls } = makeFakeRepo([]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['missing'],
    });
    expect(calls.findActiveByDescriptor).toBe(1);

    await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['missing'],
    });
    expect(calls.findActiveByDescriptor).toBe(1);
  });

  it('repo error for a single descriptor becomes unresolved with reason=db_error (fail-closed, does not crash batch)', async () => {
    // Codex review #93 contract: a repo throw MUST produce a typed
    // `db_error` failure entry, NOT collapse into a generic miss. This
    // distinction is what lets PEPs fail closed during a DB outage —
    // see RESOLVER_FAILURE_DEFAULT='block' and hasBlockingFailure().
    const rule = makeRule({ rule_descriptor: 'ok' });
    const { repo: baseRepo } = makeFakeRepo([rule]);
    const repo: PolicyRulesRepo = {
      ...baseRepo,
      async findActiveByDescriptor(args) {
        if (args.descriptor === 'crash') {
          throw new Error('connection_reset');
        }
        return baseRepo.findActiveByDescriptor(args);
      },
    };
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['ok', 'crash'],
    });

    expect(out.resolved.map((r) => r.descriptor)).toEqual(['ok']);
    expect(out.unresolved).toEqual(['crash']);
    // Typed failure entry: 'crash' is db_error, 'ok' has no failure entry.
    expect(out.failures).toEqual([{ descriptor: 'crash', reason: 'db_error' }]);
    // Caller's blocking decision: TRUE because db_error is blocking.
    expect(hasBlockingFailure(out)).toBe(true);
  });

  it('does NOT cache db_error misses (transient outage must not pin "no policy")', async () => {
    let attempts = 0;
    const { repo: baseRepo } = makeFakeRepo([]);
    const repo: PolicyRulesRepo = {
      ...baseRepo,
      async findActiveByDescriptor() {
        attempts++;
        if (attempts === 1) throw new Error('transient_db_blip');
        return makeRule({ rule_descriptor: 'flaky' });
      },
    };
    const resolver = createPolicyDescriptorResolver(repo, cache);

    // First call: db_error, NOT cached.
    const out1 = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['flaky'],
    });
    expect(out1.failures[0]?.reason).toBe('db_error');

    // Second call: repo recovers — resolver MUST re-query (not serve a
    // cached miss from the first call).
    const out2 = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['flaky'],
    });
    expect(out2.resolved).toHaveLength(1);
    expect(out2.failures).toEqual([]);
    expect(attempts).toBe(2);
  });

  it('not_found is tagged separately and is NOT a blocking failure', async () => {
    const { repo } = makeFakeRepo([]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['absent'],
    });

    expect(out.failures).toEqual([{ descriptor: 'absent', reason: 'not_found' }]);
    expect(hasBlockingFailure(out)).toBe(false);
  });

  it('scope_mismatch is its own typed reason (not collapsed into not_found)', async () => {
    const rule = makeRule({
      rule_descriptor: 'scoped',
      scope: { channel: 'whatsapp' },
    });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    const out = await resolver.resolveDescriptors({
      tenant_id: 'default',
      descriptors: ['scoped'],
      scope: { channel: 'telegram' },
    });

    expect(out.failures).toEqual([
      { descriptor: 'scoped', reason: 'scope_mismatch' },
    ]);
    expect(hasBlockingFailure(out)).toBe(false);
  });

  it('tenant_mismatch: declared tenant_id differs from active context → batch fails closed', async () => {
    // Codex review #93: the resolver MUST refuse cross-tenant calls.
    // The repo would otherwise silently use the active context and
    // resolve under the WRONG tenant.
    const rule = makeRule({ rule_descriptor: 'sensitive' });
    const { repo } = makeFakeRepo([rule]);
    const resolver = createPolicyDescriptorResolver(repo, cache);

    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const out = await resolver.resolveDescriptors({
          tenant_id: 'tenant-b', // <-- mismatch
          descriptors: ['sensitive', 'other'],
        });
        expect(out.resolved).toHaveLength(0);
        expect(out.failures).toEqual([
          { descriptor: 'sensitive', reason: 'tenant_mismatch' },
          { descriptor: 'other', reason: 'tenant_mismatch' },
        ]);
        expect(hasBlockingFailure(out)).toBe(true);
      },
    );
  });

  it('RESOLVER_FAILURE_DEFAULT invariant is pinned to "block"', () => {
    // If anyone flips this constant, the caller contract changes
    // silently. Pin the value with an explicit test so the change shows
    // up as a test failure in code review.
    expect(RESOLVER_FAILURE_DEFAULT).toBe('block');
  });

  it('hasBlockingFailure returns false when all failures are non-blocking', () => {
    expect(
      hasBlockingFailure({
        resolved: [],
        unresolved: ['a', 'b'],
        failures: [
          { descriptor: 'a', reason: 'not_found' },
          { descriptor: 'b', reason: 'scope_mismatch' },
        ],
      }),
    ).toBe(false);
  });

  it('hasBlockingFailure returns true when any failure is db_error or tenant_mismatch', () => {
    expect(
      hasBlockingFailure({
        resolved: [],
        unresolved: ['a'],
        failures: [{ descriptor: 'a', reason: 'db_error' }],
      }),
    ).toBe(true);
    expect(
      hasBlockingFailure({
        resolved: [],
        unresolved: ['a'],
        failures: [{ descriptor: 'a', reason: 'tenant_mismatch' }],
      }),
    ).toBe(true);
  });
});

describe('matchesScope helper', () => {
  it('returns true when ruleScope is empty', () => {
    expect(matchesScope({})).toBe(true);
    expect(matchesScope({}, { channel: 'x' })).toBe(true);
  });

  it('returns false when ruleScope is set but input is undefined', () => {
    expect(matchesScope({ channel: 'wa' })).toBe(false);
  });

  it('returns true when every set rule key matches input', () => {
    expect(matchesScope({ channel: 'wa' }, { channel: 'wa', domain: 'x' })).toBe(
      true,
    );
  });

  it('returns false when any rule key mismatches', () => {
    expect(matchesScope({ channel: 'wa' }, { channel: 'telegram' })).toBe(false);
  });

  it('returns true if rule has multiple keys and input has all', () => {
    expect(
      matchesScope(
        { channel: 'wa', domain: 'finance' },
        { channel: 'wa', domain: 'finance', skill_category: 'extra' },
      ),
    ).toBe(true);
  });

  it('returns false if rule has multiple keys and input misses one', () => {
    expect(matchesScope({ channel: 'wa', domain: 'finance' }, { channel: 'wa' })).toBe(
      false,
    );
  });
});
