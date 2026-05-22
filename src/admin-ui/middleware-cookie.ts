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
 * True iff the request carries a (non-empty) NextAuth session cookie under
 * any of the v4/v5 names or any chunked variant.
 *
 * Note: this only checks "a cookie is present" — it does NOT verify the JWT
 * signature, expiry, or contents. That's auth.ts's job at the tRPC context
 * boundary. The middleware is a coarse first gate that prevents authenticated
 * users from being bounced to /auth/signin (issue #179) and prevents
 * unauthenticated users from rendering an admin page shell.
 */
export function hasSessionCookie(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  for (const c of cookies) {
    if (c.value && isSessionCookieName(c.name)) return true;
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
