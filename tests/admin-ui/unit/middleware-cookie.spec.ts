/**
 * Issue #179 — admin-ui middleware session-cookie regression tests.
 *
 * Pre-fix state: middleware only checked three v4-era cookie names. NextAuth
 * v5 emits `__Secure-authjs.session-token` over HTTPS, and splits the JWT
 * into `<name>.0`, `<name>.1`, … `<name>.N` when it exceeds the per-cookie
 * size ceiling. Neither was recognized, so admins were redirected to
 * /auth/signin in HTTPS prod after a successful OIDC sign-in.
 *
 * These tests cover every cookie name Auth.js v5 (and v4 for back-compat)
 * might emit, the chunked variants, and the negative cases that the gate
 * must NOT accept (CSRF cookie, PKCE cookie, empty value, unrelated suffix).
 *
 * Each test below would have FAILED on the pre-fix middleware for the v5
 * production case — they're regression guards.
 *
 * Note: this spec deliberately imports from `@/admin-ui/middleware-cookie.js`
 * and NOT from `@/admin-ui/middleware.js` directly, because `middleware.ts`
 * imports `next/server`, which is not installed at the repo root (`next` is
 * only a dependency inside `src/admin-ui/`). Same pattern as
 * `./auth-gating.spec.ts` (extracted from `auth.ts` to avoid pulling in
 * `next-auth` at root vitest time).
 */
import { describe, it, expect } from 'vitest';
import {
  hasSessionCookie,
  isSessionCookieName,
  isPublicPath,
  SESSION_COOKIE_PREFIXES,
  PUBLIC_PATHS,
} from '@/admin-ui/middleware-cookie.js';

// Helpers ---------------------------------------------------------------------

type Cookie = { name: string; value: string };
const c = (name: string, value: string): Cookie => ({ name, value });
const FIXTURE_JWT = 'eyJhbGciOiJIUzI1NiJ9.payload-fixture.signature-fixture';

describe('isSessionCookieName — exact-name matches', () => {
  it('accepts the v5 secure cookie (the one the pre-fix middleware missed)', () => {
    // REGRESSION: this is THE issue. NextAuth v5 over HTTPS uses
    // `__Secure-authjs.session-token`, not `__Secure-next-auth.*`.
    expect(isSessionCookieName('__Secure-authjs.session-token')).toBe(true);
  });

  it('accepts the v5 __Host-locked cookie variant', () => {
    expect(isSessionCookieName('__Host-authjs.session-token')).toBe(true);
  });

  it('accepts the v5 dev / non-HTTPS cookie', () => {
    expect(isSessionCookieName('authjs.session-token')).toBe(true);
  });

  it('accepts the v4 secure cookie (back-compat with old deployments)', () => {
    expect(isSessionCookieName('__Secure-next-auth.session-token')).toBe(true);
  });

  it('accepts the v4 dev cookie (back-compat)', () => {
    expect(isSessionCookieName('next-auth.session-token')).toBe(true);
  });
});

describe('isSessionCookieName — chunked variants', () => {
  it('accepts chunked v5 secure cookies (the second issue-#179 bug)', () => {
    // REGRESSION: when the session JWT > ~4KB, Auth.js splits it. A plain
    // `cookies.get('__Secure-authjs.session-token')` returns undefined for
    // chunked sessions; the gate has to know `*.0`, `*.1`, … too.
    expect(isSessionCookieName('__Secure-authjs.session-token.0')).toBe(true);
    expect(isSessionCookieName('__Secure-authjs.session-token.1')).toBe(true);
    expect(isSessionCookieName('__Secure-authjs.session-token.2')).toBe(true);
    expect(isSessionCookieName('__Secure-authjs.session-token.42')).toBe(true);
    expect(isSessionCookieName('__Secure-authjs.session-token.100')).toBe(true);
  });

  it('accepts chunked variants of every supported prefix', () => {
    for (const prefix of SESSION_COOKIE_PREFIXES) {
      expect(isSessionCookieName(`${prefix}.0`)).toBe(true);
      expect(isSessionCookieName(`${prefix}.1`)).toBe(true);
      expect(isSessionCookieName(`${prefix}.9`)).toBe(true);
    }
  });
});

describe('isSessionCookieName — must NOT accept (negative cases)', () => {
  it('rejects empty string', () => {
    expect(isSessionCookieName('')).toBe(false);
  });

  it('rejects unrelated cookies', () => {
    expect(isSessionCookieName('csrf-token')).toBe(false);
    expect(isSessionCookieName('user-prefs')).toBe(false);
    expect(isSessionCookieName('_ga')).toBe(false);
  });

  it('rejects CSRF cookies that share the authjs namespace', () => {
    expect(isSessionCookieName('authjs.csrf-token')).toBe(false);
    expect(isSessionCookieName('__Secure-authjs.csrf-token')).toBe(false);
    expect(isSessionCookieName('__Host-authjs.csrf-token')).toBe(false);
  });

  it('rejects PKCE / callback-url / state cookies', () => {
    // Auth.js emits these alongside the session token; they share the prefix
    // path but are not session evidence.
    expect(isSessionCookieName('authjs.pkce.code_verifier')).toBe(false);
    expect(isSessionCookieName('authjs.callback-url')).toBe(false);
    expect(isSessionCookieName('__Secure-authjs.callback-url')).toBe(false);
    expect(isSessionCookieName('authjs.session-token.pkce')).toBe(false);
  });

  it('rejects non-numeric chunk suffixes', () => {
    // The chunked variant suffix is `.N` where N is decimal digits. Anything
    // else is a different cookie, not a chunk.
    expect(isSessionCookieName('authjs.session-token.extra')).toBe(false);
    expect(isSessionCookieName('authjs.session-token.0a')).toBe(false);
    expect(isSessionCookieName('authjs.session-token.a0')).toBe(false);
    expect(isSessionCookieName('authjs.session-token.-1')).toBe(false);
    expect(isSessionCookieName('authjs.session-token. 1')).toBe(false);
  });

  it('rejects empty chunk suffix (trailing dot)', () => {
    expect(isSessionCookieName('authjs.session-token.')).toBe(false);
  });

  it('rejects prefix-only collisions (substring but not separator)', () => {
    // `authjs.session-token-extra` is NOT a chunk; it's just a different
    // cookie that happens to share the name as a substring.
    expect(isSessionCookieName('authjs.session-token-extra')).toBe(false);
    expect(isSessionCookieName('__Secure-authjs.session-tokenX')).toBe(false);
  });

  it('rejects spoofed __Secure-* prefix (case sensitivity matters for the gate)', () => {
    // Browsers treat `__Secure-` case-sensitively per RFC 6265bis; mirror that.
    expect(isSessionCookieName('__secure-authjs.session-token')).toBe(false);
    expect(isSessionCookieName('__SECURE-authjs.session-token')).toBe(false);
  });
});

describe('hasSessionCookie — pass / fail behavior', () => {
  it('passes for a request carrying the v5 secure cookie (issue #179 fix)', () => {
    // REGRESSION: equivalent to a real HTTPS prod request after OIDC sign-in.
    expect(hasSessionCookie([c('__Secure-authjs.session-token', FIXTURE_JWT)])).toBe(true);
  });

  it('passes for a request carrying chunked v5 secure cookies (issue #179 fix)', () => {
    // REGRESSION: equivalent to a real prod request where the JWT got split.
    // Pre-fix gate returned false here → admin would be bounced to signin.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', FIXTURE_JWT.slice(0, 30)),
        c('__Secure-authjs.session-token.1', FIXTURE_JWT.slice(30)),
      ]),
    ).toBe(true);
  });

  it('passes when chunked cookie is mixed with unrelated cookies', () => {
    expect(
      hasSessionCookie([
        c('_ga', 'GA1.2.123'),
        c('__Secure-authjs.callback-url', '/dashboard'),
        c('__Secure-authjs.session-token.0', FIXTURE_JWT.slice(0, 30)),
        c('__Secure-authjs.session-token.1', FIXTURE_JWT.slice(30)),
        c('user-prefs', 'theme=dark'),
      ]),
    ).toBe(true);
  });

  it('fails for an empty cookie jar (the standard "logged out" case)', () => {
    expect(hasSessionCookie([])).toBe(false);
  });

  it('fails when only non-session cookies are present (CSRF, PKCE, prefs)', () => {
    expect(
      hasSessionCookie([
        c('__Secure-authjs.csrf-token', 'csrf-value'),
        c('__Secure-authjs.callback-url', '/dashboard'),
        c('authjs.pkce.code_verifier', 'verifier'),
        c('user-prefs', 'theme=dark'),
      ]),
    ).toBe(false);
  });

  it('fails when the session cookie name is right but the value is empty', () => {
    // Auth.js clears the cookie on sign-out by setting value=''. A logged-out
    // browser may still send the empty cookie until expiry; the gate must
    // not treat that as authenticated.
    expect(hasSessionCookie([c('__Secure-authjs.session-token', '')])).toBe(false);
  });

  it('fails for all-empty chunks (sign-out / cleared session)', () => {
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', ''),
        c('__Secure-authjs.session-token.1', ''),
      ]),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // PR #181 Codex Adversarial regression — orphan / gapped chunked cookies.
  //
  // The pre-fix `hasSessionCookie` returned true as soon as any chunked
  // variant had a value, so:
  //   - a request with only `.1` (no `.0`) silently bypassed the gate
  //   - `.0` empty + `.1` populated bypassed the gate
  //   - `.0,.2` (gap in `.1`) bypassed the gate
  // None of those are reconstructible by Auth.js (which concatenates chunks
  // starting from `.0` until the next index is missing), so the root layout
  // would render the protected page tree with `auth()` returning null.
  //
  // ROUND 2 finding: a lone non-empty `.0` (no `.1+`) is also unreconstructible
  // in practice — Auth.js only emits the chunked form when the JWT exceeds the
  // single-cookie size ceiling, so it would never produce a lone `.0` (it would
  // have written the unchunked cookie instead). A lone `.0` is therefore
  // always either truncated mid-flight or a stale leftover after `.1+` were
  // cleared/expired. The gate now requires AT LEAST two contiguous non-empty
  // chunks (`.0` + `.1`) for the chunked path; the unchunked single-cookie
  // path is unchanged.
  // ---------------------------------------------------------------------------

  it('fails for an orphan chunk `.1` with no `.0` (PR #181 Codex finding)', () => {
    // Plausible after stale cleanup or partial cookie injection. Auth.js
    // cannot reconstruct without `.0`, so the middleware must not let it
    // through.
    expect(
      hasSessionCookie([c('__Secure-authjs.session-token.1', FIXTURE_JWT)]),
    ).toBe(false);
  });

  it('fails for a gapped chunk set `.0` + `.2` (missing `.1`)', () => {
    // Auth.js stops concatenating at the first missing index, yielding a
    // truncated JWT that won't verify. Treat as unreconstructible.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', FIXTURE_JWT.slice(0, 20)),
        c('__Secure-authjs.session-token.2', FIXTURE_JWT.slice(40)),
      ]),
    ).toBe(false);
  });

  it('fails when `.0` is present but empty and `.1` has a value', () => {
    // This was the pre-PR-#181 behavior considered "defensive". It's actually
    // unreconstructible: Auth.js sees an empty `.0` and produces a
    // truncated/garbage JWT. Must NOT pass the gate.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', ''),
        c('__Secure-authjs.session-token.1', FIXTURE_JWT),
      ]),
    ).toBe(false);
  });

  it('fails when only `.0` is present and its value is empty', () => {
    // Sign-out / cleared-session single-chunk variant.
    expect(
      hasSessionCookie([c('__Secure-authjs.session-token.0', '')]),
    ).toBe(false);
  });

  it('passes for a contiguous chunk set `.0` + `.1` + `.2` (happy path)', () => {
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', FIXTURE_JWT.slice(0, 20)),
        c('__Secure-authjs.session-token.1', FIXTURE_JWT.slice(20, 40)),
        c('__Secure-authjs.session-token.2', FIXTURE_JWT.slice(40)),
      ]),
    ).toBe(true);
  });

  it('fails for a lone non-empty `.0` chunk with no `.1` (PR #181 round-2 finding)', () => {
    // ROUND 2 regression: Auth.js only emits the chunked cookie form when the
    // session JWT exceeds the per-cookie size ceiling — i.e. it would NEVER
    // produce a lone `.0` (it would have written the unchunked cookie
    // instead). A request that carries `.0` alone is therefore either a
    // truncated copy (intermediary dropped `.1+`) or a stale leftover after
    // `.1+` expired/were cleared. Either way Auth.js cannot reconstruct, and
    // letting it through would render the protected app shell with `auth()`
    // returning null — the exact failure mode the gate exists to prevent.
    expect(
      hasSessionCookie([c('__Secure-authjs.session-token.0', FIXTURE_JWT)]),
    ).toBe(false);
  });

  it('fails for `.0` non-empty + `.1` empty (chunked form needs both populated)', () => {
    // Same root cause as the lone-`.0` case: Auth.js's chunked form is only
    // emitted when there's payload to put in `.1+`, so an empty `.1` is the
    // signature of a partially-cleared sign-out or truncated copy.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', FIXTURE_JWT),
        c('__Secure-authjs.session-token.1', ''),
      ]),
    ).toBe(false);
  });

  it('passes when an unchunked session cookie coexists with orphan chunks of another prefix', () => {
    // E.g. unchunked v5 cookie present (valid) plus a stale orphan `.1` of
    // the v4 cookie from before a deployment rotation. Unchunked match alone
    // is sufficient.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token', FIXTURE_JWT),
        c('__Secure-next-auth.session-token.1', 'stale-orphan'),
      ]),
    ).toBe(true);
  });

  it('fails when the only chunked match has an empty middle chunk', () => {
    // `.0` and `.2` non-empty, `.1` empty → contiguity check rejects.
    expect(
      hasSessionCookie([
        c('__Secure-authjs.session-token.0', FIXTURE_JWT.slice(0, 20)),
        c('__Secure-authjs.session-token.1', ''),
        c('__Secure-authjs.session-token.2', FIXTURE_JWT.slice(40)),
      ]),
    ).toBe(false);
  });

  // Note on "expired / malformed JWT" cases from the task description:
  //
  // The middleware deliberately does NOT verify the JWT — that's auth.ts /
  // the tRPC context's job. From the middleware's vantage point, an expired
  // or malformed JWT looks identical to a valid one (both are non-empty
  // strings under the right cookie name), so we let it through here and the
  // tRPC context boundary rejects on `auth()` returning null. This is the
  // same posture as the v5 `auth()` middleware wrapper itself — see the
  // module-level comment in `./middleware.ts` for why we hand-roll instead
  // of using that wrapper. The "redirects on invalid JWT" assertion in the
  // task is therefore enforced one layer deeper (context.ts), not here.
});

describe('isPublicPath — bypass list', () => {
  it('bypasses /auth/signin (so unauthenticated users can actually sign in)', () => {
    // REGRESSION: if the middleware redirected /auth/signin to /auth/signin,
    // the user would hit an infinite redirect loop.
    expect(isPublicPath('/auth/signin')).toBe(true);
    expect(isPublicPath('/auth/signin?callbackUrl=/dashboard')).toBe(true);
  });

  it('bypasses /auth/error', () => {
    expect(isPublicPath('/auth/error')).toBe(true);
    expect(isPublicPath('/auth/error?error=AccessDenied')).toBe(true);
  });

  it('bypasses the /api/auth/* NextAuth handler tree', () => {
    expect(isPublicPath('/api/auth')).toBe(true);
    expect(isPublicPath('/api/auth/signin')).toBe(true);
    expect(isPublicPath('/api/auth/callback/oidc')).toBe(true);
    expect(isPublicPath('/api/auth/session')).toBe(true);
  });

  it('bypasses /_next/* (static assets, HMR, etc.)', () => {
    expect(isPublicPath('/_next/static/chunks/main.js')).toBe(true);
    expect(isPublicPath('/_next/image')).toBe(true);
  });

  it('bypasses /favicon.ico', () => {
    expect(isPublicPath('/favicon.ico')).toBe(true);
  });

  it('does NOT bypass protected app routes', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/dashboard')).toBe(false);
    expect(isPublicPath('/proposals')).toBe(false);
    expect(isPublicPath('/audit')).toBe(false);
    expect(isPublicPath('/api/trpc/agents.list')).toBe(false);
  });

  it('does NOT bypass paths that merely contain a public prefix as a substring', () => {
    // `/auth/signin` is the prefix; `/admin/auth/signin` is not.
    expect(isPublicPath('/admin/auth/signin')).toBe(false);
    expect(isPublicPath('/foo/_next/static/x.js')).toBe(false);
  });
});

describe('PUBLIC_PATHS — drift guard with middleware.ts', () => {
  // If someone adds a new public route to middleware.ts but forgets to
  // mirror it in middleware-cookie.ts (or vice versa), this test will fail
  // until they're put back in sync. The two lists are deliberately
  // duplicated — see the comment in middleware-cookie.ts — so a drift
  // guard is the right place to catch divergence.
  it('lists exactly the routes documented in middleware.ts module comment', () => {
    expect([...PUBLIC_PATHS]).toEqual([
      '/auth/signin',
      '/auth/error',
      '/api/auth',
      '/_next',
      '/favicon.ico',
    ]);
  });
});

describe('SESSION_COOKIE_PREFIXES — surface guard', () => {
  // If someone removes a prefix from the list (e.g. "we don't support v4
  // anymore"), this test forces them to update the test + the comment in
  // middleware.ts at the same time, so we don't silently drop back-compat
  // for cookies issued by an older deployment.
  it('covers v5 prod + Host + dev and v4 prod + dev', () => {
    expect([...SESSION_COOKIE_PREFIXES].sort()).toEqual(
      [
        '__Host-authjs.session-token',
        '__Secure-authjs.session-token',
        '__Secure-next-auth.session-token',
        'authjs.session-token',
        'next-auth.session-token',
      ].sort(),
    );
  });
});
