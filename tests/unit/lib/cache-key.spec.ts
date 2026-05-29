/**
 * Issue #287 — centralized cache-key builder tests.
 *
 * The helper exists so every Redis-backed cache encodes segments
 * deterministically and collision-free. The critical property is
 * "collision-by-delimiter": if any segment contains `:` (the join delimiter),
 * a naive concat would alias distinct tuples to the same key. URI-encoding
 * each segment before the join makes those tuples produce different keys.
 *
 * Each test below maps to a guarantee callers depend on. If you change the
 * encoding contract, you are changing the cache-key wire format — all
 * existing Redis entries written under the old encoding become stale and
 * unfetchable until they age out via TTL.
 */
import { describe, it, expect } from 'vitest';
import { buildCacheKey } from '@/lib/cache-key.js';

describe('buildCacheKey — collision-by-delimiter', () => {
  it('distinct tuples that would collide under raw `:`-concat produce DIFFERENT keys', () => {
    // Naive raw concat: `acme:dev` + `x`   →  "acme:dev:x"
    //                   `acme`     + `dev:x` →  "acme:dev:x"  (collision)
    // With URI-encoded segments, the `:` inside a segment becomes `%3A`, so
    // the two tuples produce distinct keys.
    const a = buildCacheKey('maia:bot:', 'acme:dev', 'x');
    const b = buildCacheKey('maia:bot:', 'acme', 'dev:x');
    expect(a).not.toBe(b);
    expect(a).toBe('maia:bot:acme%3Adev:x');
    expect(b).toBe('maia:bot:acme:dev%3Ax');
  });

  it('three-segment delimiter aliasing also resolves cleanly', () => {
    // (tenant, agent, phone) where any one contains `:` should not collide
    // with a different (tenant, agent, phone) tuple.
    const a = buildCacheKey('p:', 'a:b', 'c', 'd');
    const b = buildCacheKey('p:', 'a', 'b:c', 'd');
    const c = buildCacheKey('p:', 'a', 'b', 'c:d');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it.each([
    // Each row is a set of tuples that a naive `:`-concat would alias to ONE
    // key. With per-segment encoding they must all be DISTINCT.
    [[['a:b', 'c'], ['a', 'b:c']]],
    [[['a:b', 'c', 'd'], ['a', 'b:c', 'd'], ['a', 'b', 'c:d']]],
    [[['x:', 'y'], ['x', ':y'], ['x', '', ':y']]],
  ])('parametrized: colliding tuples #%# all produce distinct keys', (tuples) => {
    const keys = tuples.map((segs) => buildCacheKey('p:', ...segs));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildCacheKey — type coercion', () => {
  it('number segments are coerced to their decimal string form', () => {
    expect(buildCacheKey('rl:', 42, 'q')).toBe('rl:42:q');
    expect(buildCacheKey('rl:', 0)).toBe('rl:0');
    expect(buildCacheKey('rl:', -1, 1.5)).toBe('rl:-1:1.5');
  });
});

describe('buildCacheKey — null/undefined fail closed (B3)', () => {
  // Codex review of #305: a `null`/`undefined` segment must NOT collapse to
  // ''. Coercing it would alias "missing" with "empty string" — distinct
  // tuples hashing to the same key. The contract is fail-closed: throw.
  it('rejects a null segment with a TypeError naming the index', () => {
    expect(() => buildCacheKey('p:', 'tenant', null as unknown as string, 'phone')).toThrow(
      TypeError,
    );
    expect(() => buildCacheKey('p:', 'tenant', null as unknown as string, 'phone')).toThrow(
      /index 1/,
    );
  });

  it('rejects an undefined segment with a TypeError naming the index', () => {
    expect(() =>
      buildCacheKey('p:', 'tenant', undefined as unknown as string, 'phone'),
    ).toThrow(TypeError);
    expect(() =>
      buildCacheKey('p:', 'tenant', undefined as unknown as string, 'phone'),
    ).toThrow(/index 1/);
  });

  it('rejects null/undefined in the first or last slot too', () => {
    expect(() => buildCacheKey('p:', null as unknown as string)).toThrow(/index 0/);
    expect(() => buildCacheKey('p:', 'a', undefined as unknown as string)).toThrow(
      /index 1/,
    );
  });

  it('an explicit empty string is still accepted (the documented sentinel)', () => {
    // Callers that genuinely mean "empty segment" must opt in explicitly.
    expect(buildCacheKey('p:', 'tenant', '', 'phone')).toBe('p:tenant::phone');
  });

  it('"missing" and "empty" no longer alias — there is no null path to ""', () => {
    // The only way to produce 'p:tenant::phone' is an explicit '' — null/
    // undefined throw, so the historical aliasing is structurally impossible.
    expect(() => buildCacheKey('p:', 'tenant', null as unknown as string, 'phone')).toThrow();
    expect(buildCacheKey('p:', 'tenant', '', 'phone')).toBe('p:tenant::phone');
  });
});

describe('buildCacheKey — encoding', () => {
  it('special characters that could collide with delimiters are URI-encoded', () => {
    // `:` `/` `?` `#` `&` `=` `+` `%` `@` `\n` ` ` — all should encode.
    expect(buildCacheKey('p:', 'a:b')).toBe('p:a%3Ab');
    expect(buildCacheKey('p:', 'a/b')).toBe('p:a%2Fb');
    expect(buildCacheKey('p:', 'a?b')).toBe('p:a%3Fb');
    expect(buildCacheKey('p:', 'a#b')).toBe('p:a%23b');
    expect(buildCacheKey('p:', 'a&b')).toBe('p:a%26b');
    expect(buildCacheKey('p:', 'a+b')).toBe('p:a%2Bb');
    expect(buildCacheKey('p:', 'a%b')).toBe('p:a%25b');
    expect(buildCacheKey('p:', 'a@b')).toBe('p:a%40b');
    expect(buildCacheKey('p:', 'a b')).toBe('p:a%20b');
    expect(buildCacheKey('p:', 'a\nb')).toBe('p:a%0Ab');
  });

  it('alphanumerics, hyphens, underscores, periods, and tildes pass through unchanged', () => {
    // `encodeURIComponent` treats these as safe per RFC 3986.
    expect(buildCacheKey('p:', 'A-Z_az.09~')).toBe('p:A-Z_az.09~');
  });

  it('multi-byte unicode encodes to percent-escaped UTF-8 bytes', () => {
    // Brazilian-portuguese characters must round-trip through the encoder
    // without dropping bytes. `ç` is `%C3%A7`.
    expect(buildCacheKey('p:', 'avaliação')).toBe('p:avalia%C3%A7%C3%A3o');
  });
});

describe('buildCacheKey — Redis glob metachar safety (B4)', () => {
  // Codex review of #305 (same class of bug as PR #242): `encodeURIComponent`
  // does NOT escape `*` (nor `!`), so a segment containing one could act as a
  // wildcard inside a `KEYS`/`SCAN` `MATCH` pattern built from that segment,
  // aliasing across unrelated keys. Every glob metachar must be neutralized so
  // a segment is always a literal.
  it('percent-encodes `*` so a segment cannot become a wildcard', () => {
    expect(buildCacheKey('p:', 'tenant*')).toBe('p:tenant%2A');
    expect(buildCacheKey('p:', '*')).toBe('p:%2A');
  });

  it('percent-encodes `?` (single-char glob wildcard)', () => {
    expect(buildCacheKey('p:', 'slice?')).toBe('p:slice%3F');
  });

  it('percent-encodes `[`, `]` (glob character class)', () => {
    expect(buildCacheKey('p:', 'a[bc]d')).toBe('p:a%5Bbc%5Dd');
  });

  it('percent-encodes `!` (glob char-class negation)', () => {
    expect(buildCacheKey('p:', 'a!b')).toBe('p:a%21b');
  });

  it('a literal segment never aliases with a glob pattern segment', () => {
    // The whole point: a key written for the literal value `*` must NOT be the
    // same string as a key written for some other tenant — `*` is neutralized,
    // so it can never match `tenant1`, `tenant2`, ... as a glob would.
    const star = buildCacheKey('maia:bot:', 'tenant', '*');
    const literalT1 = buildCacheKey('maia:bot:', 'tenant', 'tenant1');
    const literalT2 = buildCacheKey('maia:bot:', 'tenant', 'tenant2');
    expect(star).toBe('maia:bot:tenant:%2A');
    expect(new Set([star, literalT1, literalT2]).size).toBe(3);
    // And the encoded form contains no raw glob metacharacter at all.
    expect(/[*?[\]!]/.test(star)).toBe(false);
  });

  it('combined: a segment full of metachars is fully neutralized', () => {
    expect(/[*?[\]!]/.test(buildCacheKey('p:', '*?[]!'))).toBe(false);
    expect(buildCacheKey('p:', '*?[]!')).toBe('p:%2A%3F%5B%5D%21');
  });
});

describe('buildCacheKey — composition', () => {
  it('preserves segment order in the joined key', () => {
    expect(buildCacheKey('rl:', 'a', 'b', 'c')).toBe('rl:a:b:c');
    expect(buildCacheKey('rl:', 'c', 'b', 'a')).toBe('rl:c:b:a');
    expect(buildCacheKey('rl:', 'a', 'b', 'c')).not.toBe(
      buildCacheKey('rl:', 'c', 'b', 'a'),
    );
  });

  it('zero segments returns just the prefix', () => {
    expect(buildCacheKey('lockdown:global')).toBe('lockdown:global');
    expect(buildCacheKey('')).toBe('');
  });

  it('one segment returns prefix + encoded segment with no trailing delimiter', () => {
    expect(buildCacheKey('rl:', 'pessoa-1')).toBe('rl:pessoa-1');
  });

  it('the prefix is NOT encoded — only segments are', () => {
    // Prefixes are namespace markers the caller controls; they intentionally
    // contain `:` (e.g. "maia:botdet:"). Encoding the prefix would break the
    // Redis keyspace convention.
    const k = buildCacheKey('maia:botdet:', 'tenant1', 'phone');
    expect(k.startsWith('maia:botdet:')).toBe(true);
    expect(k).toBe('maia:botdet:tenant1:phone');
  });
});

describe('buildCacheKey — backpressure migration parity', () => {
  // Concrete check tied to the demonstrative migration in this PR:
  // `src/scheduling/backpressure.ts` builds `outbox:pace:<jid>` with a raw
  // `:` concat. Phone-style jids contain `@` which is now URI-encoded.
  it('reproduces the new backpressure key shape (jid with @)', () => {
    expect(buildCacheKey('outbox:pace:', 'a@s.whatsapp.net')).toBe(
      'outbox:pace:a%40s.whatsapp.net',
    );
  });

  it('per-second rate key uses number segment unchanged for ASCII digits', () => {
    expect(buildCacheKey('outbox:rate:sec:', 1717000000)).toBe(
      'outbox:rate:sec:1717000000',
    );
  });
});
