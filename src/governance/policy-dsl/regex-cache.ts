/**
 * P9d — Compiled-RegExp LRU cache + ReDoS guard.
 *
 * Two responsibilities:
 *  1. **ReDoS gate**: refuses to compile patterns that fail `safe-regex2`'s
 *     static analysis (catastrophic backtracking shapes like `(a+)+`).
 *  2. **LRU cache**: bounded-size cache keyed by the raw pattern string,
 *     so policies sharing a regex share the compiled instance. Eviction
 *     uses Map insertion-order (`Map` preserves insertion order so we can
 *     re-insert on access for naive LRU).
 *
 * The cache is process-local and reset for tests via `resetRegexCache()`.
 * In production it stays warm for the lifetime of the worker; the bound
 * (`REGEX_CACHE_MAX`) limits memory growth even with adversarial pattern
 * cardinality.
 *
 * `compileSafeRegex()` returns `null` for unsafe patterns so the caller
 * (evaluator) can surface `regex_pattern_unsafe` deterministically without
 * a thrown exception.
 */

// `safe-regex2` ships its own `.d.ts`; the default export is the predicate.
import safeRegex from 'safe-regex2';
import { REGEX_CACHE_MAX } from './constants.js';

type CacheEntry =
  | { ok: true; regex: RegExp }
  | { ok: false; reason: 'unsafe' | 'invalid' };

type CacheStats = {
  hits: number;
  misses: number;
  compiled: number;
  evicted: number;
  size: number;
};

const cache: Map<string, CacheEntry> = new Map();
const stats: CacheStats = {
  hits: 0,
  misses: 0,
  compiled: 0,
  evicted: 0,
  size: 0,
};

/**
 * Compile a pattern, gated by `safe-regex2`. Returns `null` for unsafe
 * patterns or invalid syntax. Caches both successes and failures so
 * adversarial inputs don't repeatedly run the static analyser.
 *
 * The cache key is the raw pattern string. Flags are not part of the key
 * because the DSL never exposes them (regexes are always built `new RegExp(p)`
 * with no flags). Surfacing flag support would require an Architecture Lock
 * change.
 */
export function compileSafeRegex(pattern: string): RegExp | null {
  const cached = cache.get(pattern);
  if (cached) {
    stats.hits += 1;
    // LRU touch: re-insert to move to the most-recently-used end.
    cache.delete(pattern);
    cache.set(pattern, cached);
    return cached.ok ? cached.regex : null;
  }

  stats.misses += 1;

  // We classify failures into two categories:
  //  - 'invalid'   → the pattern is not a syntactically valid RegExp.
  //  - 'unsafe'    → it parses, but `safe-regex2` flagged catastrophic
  //                  backtracking risk.
  //
  // `safe-regex2` returns `false` for both cases (invalid patterns can't be
  // analysed), so we test syntactic validity FIRST via `new RegExp` and
  // only run the safety check when the pattern parses cleanly.
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    insert(pattern, { ok: false, reason: 'invalid' });
    return null;
  }

  let safe: boolean;
  try {
    safe = safeRegex(pattern);
  } catch {
    safe = false;
  }
  if (!safe) {
    insert(pattern, { ok: false, reason: 'unsafe' });
    return null;
  }

  stats.compiled += 1;
  insert(pattern, { ok: true, regex });
  return regex;
}

/**
 * Returns whether the cached entry for `pattern` (if any) is a known-unsafe
 * marker. Used by callers that want to differentiate "unsafe pattern" from
 * "compile failure" without re-running `safeRegex`.
 */
export function isPatternMarkedUnsafe(pattern: string): boolean {
  const entry = cache.get(pattern);
  return entry?.ok === false && entry.reason === 'unsafe';
}

/** Sister of `isPatternMarkedUnsafe` for the `'invalid'` failure reason. */
export function isPatternMarkedInvalid(pattern: string): boolean {
  const entry = cache.get(pattern);
  return entry?.ok === false && entry.reason === 'invalid';
}

/** Read-only snapshot of cache counters (for diagnostics + tests). */
export function getRegexCacheStats(): Readonly<CacheStats> {
  return { ...stats, size: cache.size };
}

/** Test-only: reset cache + counters so tests are deterministic. */
export function resetRegexCache(): void {
  cache.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.compiled = 0;
  stats.evicted = 0;
  stats.size = 0;
}

function insert(pattern: string, entry: CacheEntry): void {
  if (cache.size >= REGEX_CACHE_MAX) {
    // Evict least-recently-used (first inserted).
    const oldest = cache.keys().next();
    if (!oldest.done && oldest.value !== undefined) {
      cache.delete(oldest.value);
      stats.evicted += 1;
    }
  }
  cache.set(pattern, entry);
}
