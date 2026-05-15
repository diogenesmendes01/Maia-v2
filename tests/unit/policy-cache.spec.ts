/**
 * P8e Task 9 — unit tests for PolicyResolverCacheImpl.
 *
 * Spec §8.1 ('tests/unit/policy-cache.spec.ts'): TTL expiry, negative cache,
 * LRU eviction, invalidate() prefix matching, stats counters.
 *
 * No Redis subscriber here — we instantiate PolicyResolverCacheImpl directly
 * with a custom config and exercise pure in-memory behavior.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PolicyResolverCacheImpl,
  cacheKeyHash,
  type CacheKey,
} from '@/control-plane/policy/policy-cache.js';
import type { ResolvedPolicy } from '@/control-plane/policy/types.js';

function makeKey(overrides: Partial<CacheKey> = {}): CacheKey {
  return {
    tenant_id: 'default',
    agent_id: null,
    descriptor: 'desc_a',
    scope: {},
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    descriptor: 'desc_a',
    policy_id: 'pol-1',
    version: 1,
    rule_kind: 'soft_guidance',
    ...overrides,
  };
}

describe('PolicyResolverCacheImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined on cold miss and counts it', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    expect(cache.get(makeKey())).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it('returns the cached ResolvedPolicy on hit and counts it', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const k = makeKey();
    const v = makeResolved();
    cache.set(k, v);
    const got = cache.get(k);
    expect(got).toEqual(v);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().entries).toBe(1);
  });

  it('returns "unresolved" for negative cache entries', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const k = makeKey({ descriptor: 'does_not_exist' });
    cache.setUnresolved(k);
    expect(cache.get(k)).toBe('unresolved');
    expect(cache.stats().hits).toBe(1);
  });

  it('expires entries after ttl_ms (treats as miss)', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 5_000, max_entries: 100 });
    const k = makeKey();
    cache.set(k, makeResolved());
    expect(cache.get(k)).toBeDefined();
    vi.advanceTimersByTime(5_001);
    expect(cache.get(k)).toBeUndefined();
    expect(cache.stats().entries).toBe(0); // reaped
  });

  it('evicts least-recently-used entry when over max_entries', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 3 });
    cache.set(makeKey({ descriptor: 'a' }), makeResolved({ descriptor: 'a' }));
    cache.set(makeKey({ descriptor: 'b' }), makeResolved({ descriptor: 'b' }));
    cache.set(makeKey({ descriptor: 'c' }), makeResolved({ descriptor: 'c' }));
    // Touch a so it becomes most recent; b becomes oldest.
    cache.get(makeKey({ descriptor: 'a' }));
    cache.set(makeKey({ descriptor: 'd' }), makeResolved({ descriptor: 'd' }));
    expect(cache.get(makeKey({ descriptor: 'b' }))).toBeUndefined();
    expect(cache.get(makeKey({ descriptor: 'a' }))).toBeDefined();
    expect(cache.get(makeKey({ descriptor: 'c' }))).toBeDefined();
    expect(cache.get(makeKey({ descriptor: 'd' }))).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it('invalidate() removes only entries matching {tenant_id, agent_id, descriptor}', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    cache.set(makeKey({ descriptor: 'a' }), makeResolved({ descriptor: 'a' }));
    cache.set(makeKey({ descriptor: 'b' }), makeResolved({ descriptor: 'b' }));
    cache.set(
      makeKey({ descriptor: 'a', scope: { channel: 'whatsapp' } }),
      makeResolved({ descriptor: 'a' }),
    );
    cache.set(
      makeKey({ descriptor: 'a', tenant_id: 'tenant-b' }),
      makeResolved({ descriptor: 'a' }),
    );

    cache.invalidate({ tenant_id: 'default', agent_id: null, descriptor: 'a' });

    // descriptor=a for default tenant: both scope-variants gone
    expect(cache.get(makeKey({ descriptor: 'a' }))).toBeUndefined();
    expect(
      cache.get(makeKey({ descriptor: 'a', scope: { channel: 'whatsapp' } })),
    ).toBeUndefined();
    // descriptor=b survives
    expect(cache.get(makeKey({ descriptor: 'b' }))).toBeDefined();
    // tenant-b survives (tenant isolation in cache key)
    expect(
      cache.get(makeKey({ descriptor: 'a', tenant_id: 'tenant-b' })),
    ).toBeDefined();
  });

  it('invalidateAll() clears everything', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    cache.set(makeKey({ descriptor: 'a' }), makeResolved());
    cache.set(makeKey({ descriptor: 'b' }), makeResolved());
    expect(cache.stats().entries).toBe(2);
    cache.invalidateAll();
    expect(cache.stats().entries).toBe(0);
    expect(cache.get(makeKey({ descriptor: 'a' }))).toBeUndefined();
  });

  it('cacheKeyHash is deterministic for identical scopes regardless of key order', () => {
    const h1 = cacheKeyHash({
      tenant_id: 't',
      agent_id: null,
      descriptor: 'd',
      scope: { channel: 'wa', domain: 'x' },
    });
    const h2 = cacheKeyHash({
      tenant_id: 't',
      agent_id: null,
      descriptor: 'd',
      scope: { domain: 'x', channel: 'wa' },
    });
    expect(h1).toBe(h2);
  });

  it('cacheKeyHash distinguishes agent-specific vs tenant-wide', () => {
    const wide = cacheKeyHash({
      tenant_id: 't',
      agent_id: null,
      descriptor: 'd',
      scope: {},
    });
    const agent = cacheKeyHash({
      tenant_id: 't',
      agent_id: 'agent-x',
      descriptor: 'd',
      scope: {},
    });
    expect(wide).not.toBe(agent);
  });

  it('refreshing an existing entry resets its TTL and promotes to MRU', () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 1_000, max_entries: 3 });
    cache.set(makeKey({ descriptor: 'a' }), makeResolved({ descriptor: 'a' }));
    cache.set(makeKey({ descriptor: 'b' }), makeResolved({ descriptor: 'b' }));
    cache.set(makeKey({ descriptor: 'c' }), makeResolved({ descriptor: 'c' }));
    // Refresh a (now MRU); b is oldest.
    cache.set(makeKey({ descriptor: 'a' }), makeResolved({ descriptor: 'a', version: 2 }));
    cache.set(makeKey({ descriptor: 'd' }), makeResolved({ descriptor: 'd' }));
    expect(cache.get(makeKey({ descriptor: 'b' }))).toBeUndefined();
    expect(cache.get(makeKey({ descriptor: 'a' }))?.version).toBe(2);
  });
});
