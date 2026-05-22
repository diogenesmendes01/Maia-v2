/**
 * Issue #179 — Auth.js v5 cookie-name resolver for the admin-ui middleware.
 *
 * Lives in its own module (next/server-free, next-auth-free) so the root
 * vitest job can unit-test the gate WITHOUT depending on `next` or
 * `next-auth` being installed at the repo root. This mirrors the precedent
 * set by `./lib/auth-resolver.ts` (extracted to keep the resolver testable
 * without NextAuth) and `./lib/auth-gating.ts` (extracted to keep the
 * gating predicate testable without env-of-the-world).
 *
 * Design rationale and the reason we hand-roll instead of using the v5
 * `auth()` middleware wrapper lives at the top of `./middleware.ts`.
 */

/**
 * Cookie-name prefixes that indicate "a NextAuth session is present".
 *
 * The list covers Auth.js v5 (current) and v4 (back-compat with deployments
 * that haven't rotated their cookies yet):
 *
 *   v5 prod (HTTPS, default):    __Secure-authjs.session-token
 *   v5 prod (Host-locked):       __Host-authjs.session-token
 *   v5 dev / non-HTTPS:          authjs.session-token
 *   v4 prod (HTTPS):             __Secure-next-auth.session-token
 *   v4 dev / non-HTTPS:          next-auth.session-token
 *
 * Each prefix matches BOTH the unchunked cookie (exact name) and the chunked
 * variants (`<prefix>.0`, `<prefix>.1`, …, `<prefix>.N`) that Auth.js emits
 * when the session JWT exceeds the ~4KB per-cookie ceiling.
 */
export const SESSION_COOKIE_PREFIXES = [
  '__Secure-authjs.session-token',
  '__Host-authjs.session-token',
  'authjs.session-token',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
] as const;

/**
 * True iff `cookieName` is one of the known session-cookie names OR a
 * chunked variant of one. A chunk index is a `.` followed by one or more
 * decimal digits (`.0`, `.1`, `.10`, …).
 *
 * Examples:
 *
 *   __Secure-authjs.session-token        → true   (v5 prod, unchunked)
 *   __Secure-authjs.session-token.0      → true   (v5 prod, chunk 0)
 *   __Secure-authjs.session-token.42     → true   (v5 prod, chunk 42)
 *   authjs.session-token.pkce            → false  (different cookie, not a session)
 *   authjs.session-token.extra-suffix    → false  (non-numeric suffix)
 *   __Secure-authjs.csrf-token           → false  (CSRF, not session)
 *   ''                                   → false
 */
export function isSessionCookieName(cookieName: string): boolean {
  for (const prefix of SESSION_COOKIE_PREFIXES) {
    if (cookieName === prefix) return true;
    if (cookieName.length > prefix.length + 1 && cookieName.startsWith(prefix + '.')) {
      const suffix = cookieName.slice(prefix.length + 1);
      if (/^\d+$/.test(suffix)) return true;
    }
  }
  return false;
}

/**
 * Internal: classify a cookie name against the known session-cookie prefixes.
 *
 * Returns:
 *   - `{ kind: 'exact', prefix }`   for an unchunked match (`name === prefix`)
 *   - `{ kind: 'chunk', prefix, index }` for a chunked match (`<prefix>.N`)
 *   - `null` if the name is not a known session cookie
 *
 * Used by `hasSessionCookie` to group chunked variants by prefix so we can
 * enforce the "chunk `.0` present and contiguous" rule (see that function's
 * doc-comment for why).
 */
function classifySessionCookieName(
  cookieName: string,
): { kind: 'exact'; prefix: string } | { kind: 'chunk'; prefix: string; index: number } | null {
  for (const prefix of SESSION_COOKIE_PREFIXES) {
    if (cookieName === prefix) return { kind: 'exact', prefix };
    if (cookieName.length > prefix.length + 1 && cookieName.startsWith(prefix + '.')) {
      const suffix = cookieName.slice(prefix.length + 1);
      if (/^\d+$/.test(suffix)) {
        return { kind: 'chunk', prefix, index: Number.parseInt(suffix, 10) };
      }
    }
  }
  return null;
}

/**
 * True iff the request carries a (non-empty) NextAuth session cookie that
 * Auth.js could plausibly reconstruct into a session.
 *
 * Rules:
 *
 *   1. **Unchunked cookie** (e.g. `__Secure-authjs.session-token`): present
 *      and non-empty value ⇒ valid.
 *
 *   2. **Chunked cookies** (e.g. `__Secure-authjs.session-token.0`,
 *      `__Secure-authjs.session-token.1`, …): per Auth.js's chunking format,
 *      Auth.js reconstructs the session JWT by concatenating chunks in order
 *      starting from index `0`. For the middleware gate to mirror that:
 *        - chunk `.0` for that prefix MUST be present AND have a non-empty value
 *        - the chunk index set MUST be contiguous starting at 0 (`0,1,2,…,N`).
 *      All present chunks must be non-empty.
 *      Orphan chunks (e.g. only `.1` with no `.0`) or gapped chunks
 *      (e.g. `.0,.2` missing `.1`) cannot be reconstructed by Auth.js and
 *      MUST NOT pass the gate — otherwise the root layout renders the
 *      protected page tree with `auth()` returning null. See PR #181 Codex
 *      Adversarial finding.
 *
 *   3. A request may have a valid unchunked cookie under one prefix AND
 *      stale chunks under another; the unchunked match alone is sufficient.
 *
 * Note: this only checks "a cookie is plausibly reconstructible" — it does
 * NOT verify the JWT signature, expiry, or contents. That's auth.ts's job
 * at the tRPC context boundary. The middleware is a coarse first gate that
 * prevents authenticated users from being bounced to /auth/signin (issue
 * #179) and prevents unauthenticated users from rendering an admin page
 * shell.
 */
export function hasSessionCookie(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  // Group chunked cookies by prefix; track exact (unchunked) matches separately.
  // We need both buckets per-prefix because a request can technically carry
  // (stale) chunks under one prefix and a fresh unchunked cookie under another
  // — the unchunked match alone is still sufficient.
  const exactValid = new Set<string>(); // prefixes with a non-empty unchunked match
  const chunks = new Map<string, Map<number, string>>(); // prefix → (index → value)

  for (const c of cookies) {
    const cls = classifySessionCookieName(c.name);
    if (cls === null) continue;
    if (cls.kind === 'exact') {
      if (c.value) exactValid.add(cls.prefix);
      continue;
    }
    // chunk
    let perPrefix = chunks.get(cls.prefix);
    if (perPrefix === undefined) {
      perPrefix = new Map<number, string>();
      chunks.set(cls.prefix, perPrefix);
    }
    perPrefix.set(cls.index, c.value);
  }

  if (exactValid.size > 0) return true;

  // For each prefix with chunked cookies, enforce: `.0` present + non-empty,
  // contiguous indexes starting at 0, and every present chunk non-empty.
  // (An empty `.0` is the sign-out / cleared-cookie state — must NOT pass.)
  for (const perPrefix of chunks.values()) {
    const zero = perPrefix.get(0);
    if (zero === undefined || zero === '') continue; // no .0 or empty .0 ⇒ unreconstructible

    const indexes = [...perPrefix.keys()].sort((a, b) => a - b);
    let contiguous = true;
    for (let i = 0; i < indexes.length; i++) {
      if (indexes[i] !== i) {
        contiguous = false;
        break;
      }
      // All present chunks must be non-empty — Auth.js concatenates raw
      // values, so an empty middle chunk yields a truncated/garbage JWT.
      if (perPrefix.get(i) === '') {
        contiguous = false;
        break;
      }
    }
    if (contiguous) return true;
  }

  return false;
}

/**
 * Public path prefixes that bypass the session-cookie check.
 *
 * Kept in sync with `./middleware.ts`; exported here so the unit test can
 * verify membership without importing `next/server`.
 */
export const PUBLIC_PATHS = [
  '/auth/signin',
  '/auth/error',
  '/api/auth',
  '/_next',
  '/favicon.ico',
] as const;

/**
 * True iff `pathname` should bypass the session check.
 */
export function isPublicPath(pathname: string): boolean {
  for (const p of PUBLIC_PATHS) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}
