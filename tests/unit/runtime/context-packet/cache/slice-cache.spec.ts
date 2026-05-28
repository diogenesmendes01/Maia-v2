/**
 * P8a Task 12 — SliceCache tests.
 *
 * Tests against the in-memory implementation (deterministic for unit tests).
 * RedisSliceCache is exercised via integration tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemorySliceCache,
  sliceCacheKey,
} from '@/runtime/context-packet/cache/slice-cache.js';

describe('SliceCache (in-memory)', () => {
  let cache: InMemorySliceCache;

  beforeEach(() => {
    cache = new InMemorySliceCache();
  });

  it('get returns null on cache miss', async () => {
    const result = await cache.get('nonexistent_key');
    expect(result).toBeNull();
  });

  it('set + get returns the same value', async () => {
    const data = { foo: 'bar', n: 42 };
    await cache.set('key1', data, 300);
    const result = await cache.get<typeof data>('key1');
    expect(result).toEqual(data);
  });

  it('expired entries return null', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('key1', { x: 1 }, 60); // 60s baseline
      // Advance time past the worst-case jittered TTL (66s = 60 * 1.1).
      vi.advanceTimersByTime(120_000);
      const result = await cache.get('key1');
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidate by pattern removes matching keys', async () => {
    // Issue #235: key layout is `maia:context:v2:{tenant}:{agent}:{slice}:{scope}`.
    await cache.set('maia:context:v2:tenant1:agentA:identity:scope1', { x: 1 }, 300);
    await cache.set('maia:context:v2:tenant1:agentA:identity:scope2', { y: 2 }, 300);
    await cache.set('maia:context:v2:tenant2:agentA:identity:scope1', { z: 3 }, 300);
    const removed = await cache.invalidate('maia:context:v2:tenant1:*:identity:*');
    expect(removed).toBe(2);
    expect(await cache.get('maia:context:v2:tenant1:agentA:identity:scope1')).toBeNull();
    expect(await cache.get('maia:context:v2:tenant2:agentA:identity:scope1')).toEqual({
      z: 3,
    });
  });

  it('invalidateSliceForTenant scopes by tenant + slice (across all agents)', async () => {
    await cache.set('maia:context:v2:tA:agA:policy:s1', { a: 1 }, 300);
    await cache.set('maia:context:v2:tA:agB:policy:s2', { a: 2 }, 300);
    await cache.set('maia:context:v2:tA:agA:identity:s1', { i: 1 }, 300);
    await cache.set('maia:context:v2:tB:agA:policy:s1', { b: 1 }, 300);

    const removed = await cache.invalidateSliceForTenant('tA', 'policy');
    // Issue #235: BOTH agents' policy slices under tA must drop.
    expect(removed).toBe(2);
    expect(await cache.get('maia:context:v2:tA:agA:policy:s1')).toBeNull();
    expect(await cache.get('maia:context:v2:tA:agB:policy:s2')).toBeNull();
    expect(await cache.get('maia:context:v2:tA:agA:identity:s1')).toEqual({ i: 1 });
    expect(await cache.get('maia:context:v2:tB:agA:policy:s1')).toEqual({ b: 1 });
  });

  it('invalidate returns 0 when no keys match', async () => {
    const removed = await cache.invalidate('maia:context:v2:none:*');
    expect(removed).toBe(0);
  });

  it('sliceCacheKey builds the canonical v2 key format with agent_id', () => {
    // Issue #235: layout is `maia:context:v2:{tenant}:{agent}:{slice}:{scope}`.
    expect(sliceCacheKey('tenant1', 'agent1', 'identity', 'abc123')).toBe(
      'maia:context:v2:tenant1:agent1:identity:abc123',
    );
  });

  // ─── Issue #235 — cross-agent isolation (LOW, latent) ─────────────────────
  it('Issue #235: sliceCacheKey produces DIFFERENT keys for different agents on same tenant', () => {
    const a = sliceCacheKey('tenant1', 'agentA', 'identity', 'samescope');
    const b = sliceCacheKey('tenant1', 'agentB', 'identity', 'samescope');
    expect(a).not.toBe(b);
  });

  it('Issue #235: sliceCacheKey symmetric — swapping agent ids swaps keys', () => {
    const a1 = sliceCacheKey('tenant1', 'agentA', 'identity', 'samescope');
    const b1 = sliceCacheKey('tenant1', 'agentB', 'identity', 'samescope');
    const a2 = sliceCacheKey('tenant1', 'agentA', 'identity', 'samescope');
    const b2 = sliceCacheKey('tenant1', 'agentB', 'identity', 'samescope');
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });

  it('Issue #235: sliceCacheKey version bumped to v2 (regression for v1 → v2 cache invalidation)', () => {
    const key = sliceCacheKey('tenant1', 'agent1', 'identity', 'scope1');
    expect(key.startsWith('maia:context:v2:')).toBe(true);
    expect(key).not.toMatch(/^maia:context:tenant1:/);
  });

  it('Issue #235: set + get for agentA does not leak to agentB', async () => {
    const keyA = sliceCacheKey('tenant1', 'agentA', 'knowledge', 'scope-x');
    const keyB = sliceCacheKey('tenant1', 'agentB', 'knowledge', 'scope-x');
    await cache.set(keyA, { agent: 'A', rules: ['rA1', 'rA2'] }, 300);
    expect(await cache.get(keyB)).toBeNull();
    expect(await cache.get(keyA)).toEqual({ agent: 'A', rules: ['rA1', 'rA2'] });
  });
});
