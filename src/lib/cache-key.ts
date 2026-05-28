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
 * `buildCacheKey()` solves this by URI-encoding each segment before joining
 * — `:` inside a segment becomes `%3A` and the join-`:` stays unambiguous.
 *
 * Usage:
 *   const key = buildCacheKey('maia:botdet:', tenant_id, agent_id, phone);
 *   // → "maia:botdet:<tenant>:<agent>:<phone>" with each component encoded
 *
 * Migration status: this helper is the destination for issue #287's
 * consolidation. Multiple in-flight PRs (#241, #252, #253, #257, #258, #259,
 * #272) currently use ad-hoc `buildKey()` patterns; they will be migrated in
 * follow-up PRs once merged to avoid massive rebase conflicts. See PR body
 * for the migration roster.
 */
export function buildCacheKey(
  prefix: string,
  ...segments: Array<string | number | null | undefined>
): string {
  // We deliberately accept null/undefined and coerce to '' so callers do not
  // need to guard optional fields at the call site. An empty segment still
  // occupies one slot in the joined string, which is the correct behavior:
  // (tenant=X, agent=null) and (tenant=X, agent='') hash identically only
  // when both produce '' here — that is the documented contract.
  const encoded = segments.map((s) =>
    encodeURIComponent(s === null || s === undefined ? '' : String(s)),
  );
  return prefix + encoded.join(':');
}
