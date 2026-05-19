/**
 * P9d — `regex-cache.ts` unit tests.
 *
 * Coverage:
 *  - Compiles safe patterns and reuses cached instances.
 *  - Returns null for unsafe patterns (catastrophic backtracking shapes).
 *  - Returns null for invalid regex syntax.
 *  - Cache stats track hits/misses/compiles/evictions.
 *  - LRU eviction kicks in past `REGEX_CACHE_MAX`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  compileSafeRegex,
  getRegexCacheStats,
  isPatternMarkedUnsafe,
  resetRegexCache,
} from '@/governance/policy-dsl/regex-cache.js';
import { REGEX_CACHE_MAX } from '@/governance/policy-dsl/constants.js';

afterEach(() => {
  resetRegexCache();
});

describe('compileSafeRegex', () => {
  it('compiles a safe pattern', () => {
    const re = compileSafeRegex('^foo$');
    expect(re).not.toBeNull();
    expect(re?.test('foo')).toBe(true);
  });

  it('returns the same RegExp instance on a cache hit', () => {
    const a = compileSafeRegex('^bar$');
    const b = compileSafeRegex('^bar$');
    expect(a).toBe(b);
    const stats = getRegexCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.compiled).toBe(1);
  });

  it('rejects catastrophic-backtracking patterns', () => {
    // Classic ReDoS shape: `(a+)+`
    const re = compileSafeRegex('(a+)+$');
    expect(re).toBeNull();
    expect(isPatternMarkedUnsafe('(a+)+$')).toBe(true);
  });

  it('rejects invalid regex syntax', () => {
    const re = compileSafeRegex('[unclosed');
    expect(re).toBeNull();
    expect(isPatternMarkedUnsafe('[unclosed')).toBe(false);
  });

  it('keeps unsafe patterns in cache so re-evaluation is O(1)', () => {
    compileSafeRegex('(a+)+$');
    compileSafeRegex('(a+)+$');
    const stats = getRegexCacheStats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });
});

describe('LRU eviction', () => {
  it('evicts the least-recently-used entry past the cap', () => {
    // Fill cache with REGEX_CACHE_MAX distinct safe patterns.
    for (let i = 0; i < REGEX_CACHE_MAX; i += 1) {
      compileSafeRegex(`^p${i}$`);
    }
    const beforeStats = getRegexCacheStats();
    expect(beforeStats.size).toBe(REGEX_CACHE_MAX);

    // Insert one more — pattern 0 should be evicted.
    compileSafeRegex(`^p${REGEX_CACHE_MAX}$`);
    const afterStats = getRegexCacheStats();
    expect(afterStats.size).toBe(REGEX_CACHE_MAX);
    expect(afterStats.evicted).toBeGreaterThanOrEqual(1);
  });

  it('touching an entry moves it to MRU and protects it from eviction', () => {
    for (let i = 0; i < REGEX_CACHE_MAX; i += 1) {
      compileSafeRegex(`^p${i}$`);
    }
    // Touch p0 → moves to MRU end.
    compileSafeRegex('^p0$');
    // Inserting one more should now evict p1, not p0.
    compileSafeRegex(`^p${REGEX_CACHE_MAX}$`);
    // p0 still resolves (came from cache) — verify by hit count growth.
    const before = getRegexCacheStats().hits;
    compileSafeRegex('^p0$');
    expect(getRegexCacheStats().hits).toBe(before + 1);
  });
});
