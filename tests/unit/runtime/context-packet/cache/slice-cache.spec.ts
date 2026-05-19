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
    await cache.set('maia:context:tenant1:identity:scope1', { x: 1 }, 300);
    await cache.set('maia:context:tenant1:identity:scope2', { y: 2 }, 300);
    await cache.set('maia:context:tenant2:identity:scope1', { z: 3 }, 300);
    const removed = await cache.invalidate('maia:context:tenant1:identity:*');
    expect(removed).toBe(2);
    expect(await cache.get('maia:context:tenant1:identity:scope1')).toBeNull();
    expect(await cache.get('maia:context:tenant2:identity:scope1')).toEqual({
      z: 3,
    });
  });

  it('invalidateSliceForTenant scopes by tenant + slice', async () => {
    await cache.set('maia:context:tA:policy:s1', { a: 1 }, 300);
    await cache.set('maia:context:tA:policy:s2', { a: 2 }, 300);
    await cache.set('maia:context:tA:identity:s1', { i: 1 }, 300);
    await cache.set('maia:context:tB:policy:s1', { b: 1 }, 300);

    const removed = await cache.invalidateSliceForTenant('tA', 'policy');
    expect(removed).toBe(2);
    expect(await cache.get('maia:context:tA:policy:s1')).toBeNull();
    expect(await cache.get('maia:context:tA:identity:s1')).toEqual({ i: 1 });
    expect(await cache.get('maia:context:tB:policy:s1')).toEqual({ b: 1 });
  });

  it('invalidate returns 0 when no keys match', async () => {
    const removed = await cache.invalidate('maia:context:none:*');
    expect(removed).toBe(0);
  });

  it('sliceCacheKey builds the canonical key format', () => {
    expect(sliceCacheKey('tenant1', 'identity', 'abc123')).toBe(
      'maia:context:tenant1:identity:abc123',
    );
  });
});
