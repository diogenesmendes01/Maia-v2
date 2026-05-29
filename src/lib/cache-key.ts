/**
 * Centralized Redis/in-memory cache-key builder.
 *
 * Surfaced via issue #287 (Codex review of PR #252): caches across the
 * codebase concatenate tenant_id/agent_id/phone/pessoa_id with `:` as a raw
 * delimiter. If ANY segment ever contains a literal `:` (today or via an
 * upstream change to ID format), distinct tuples can collide on the same
 * cache key.
 *
 *   Example collision (raw concat):
 *     `acme:dev` + `x`   →  "acme:dev:x"
 *     `acme`     + `dev:x` → "acme:dev:x"
 *
 * `buildCacheKey()` solves this by encoding each segment before joining —
 * `:` inside a segment becomes `%3A` and the join-`:` stays unambiguous.
 *
 * Two correctness guarantees beyond delimiter-encoding (Codex review of #305):
 *
 *  1. **Fail-closed on `null`/`undefined` (B3).** A missing segment is a bug
 *     at the call site, not a value to silently fold into `''`. Coercing
 *     `null`/`undefined` to `''` aliases "absent" with "empty string" — e.g.
 *     `buildCacheKey('p:', 't', null)` and `buildCacheKey('p:', 't', '')`
 *     would hash to the same key. We throw a `TypeError` (naming the offending
 *     index) instead, so the caller must pass an explicit sentinel.
 *
 *  2. **Glob-safe segments (B4).** `encodeURIComponent` does NOT escape the
 *     Redis glob metacharacters `*` and `!` (and historically `?`/`[`/`]` on
 *     some encoders). An un-neutralized `*` in a segment turns a `KEYS`/`SCAN`
 *     `MATCH` pattern built from that segment into a wildcard, aliasing across
 *     unrelated keys. We additionally percent-encode `* ? [ ] !` so every
 *     segment is always a Redis-glob literal.
 *
 * Usage:
 *   const key = buildCacheKey('maia:botdet:', tenant_id, agent_id, phone);
 *   // → "maia:botdet:<tenant>:<agent>:<phone>" with each component encoded
 *
 * Migration status: this helper is the destination for issue #287's
 * consolidation. 11+ call sites still use ad-hoc local builders / inline
 * `encodeURIComponent` (`bot-detection.ts`, `rate-limit.ts`, `debouncer.ts`,
 * `dedup.ts`, `holidays-cache.ts`, `_vision-cache.ts`, `memory/working.ts`,
 * `slice-cache.ts`, `user-layer/internal/cache-keys.ts`,
 * `governance/idempotency.ts`, ...). They are migrated in follow-up work
 * tracked by issue #287 to avoid massive rebase conflicts.
 */

/**
 * Redis glob metacharacters that `encodeURIComponent` leaves intact and that
 * would otherwise let a segment escape its literal slot inside a `KEYS`/`SCAN`
 * `MATCH` pattern. `?`, `[`, `]` are already percent-encoded by
 * `encodeURIComponent` on modern engines; we encode them explicitly too so the
 * guarantee does not silently depend on the encoder's behavior.
 */
const GLOB_METACHAR_RE = /[*?[\]!]/g;

function neutralizeGlobMetachar(c: string): string {
  switch (c) {
    case '*':
      return '%2A';
    case '?':
      return '%3F';
    case '[':
      return '%5B';
    case ']':
      return '%5D';
    case '!':
      return '%21';
    default:
      // Unreachable: GLOB_METACHAR_RE only matches the cases above.
      return encodeURIComponent(c);
  }
}

function encodeSegment(segment: string): string {
  // First URI-encode (handles `:` `/` `%` `@` whitespace, multi-byte UTF-8,
  // etc.), then neutralize any residual Redis glob metacharacter so the
  // segment is always matched literally.
  return encodeURIComponent(segment).replace(GLOB_METACHAR_RE, neutralizeGlobMetachar);
}

export function buildCacheKey(
  prefix: string,
  ...segments: Array<string | number>
): string {
  const encoded = segments.map((s, i) => {
    // Fail closed: a `null`/`undefined` segment is almost always a forgotten
    // optional field. Silently coercing it to '' aliases "missing" with
    // "empty" and produces colliding keys. Reject it loudly, naming the index.
    if (s === null || s === undefined) {
      throw new TypeError(
        `buildCacheKey: segment at index ${i} is ${String(
          s,
        )}; pass an explicit value (e.g. '') instead of null/undefined to avoid cache-key aliasing`,
      );
    }
    return encodeSegment(String(s));
  });
  return prefix + encoded.join(':');
}
