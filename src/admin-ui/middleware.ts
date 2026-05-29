/**
 * P8.5 — Next.js middleware. Route-level protection.
 *
 * Public routes: /auth/*, /api/auth/*, _next/*. Everything else requires
 * a NextAuth session cookie. Tenant assertion happens at the tRPC layer
 * (see ./trpc/context.ts).
 *
 * ---------------------------------------------------------------------------
 * Issue #179 — Auth.js v5 cookie name + chunked-cookie awareness
 * ---------------------------------------------------------------------------
 *
 * The pre-fix middleware checked exactly three cookie names:
 *
 *     next-auth.session-token            (v4 dev)
 *     __Secure-next-auth.session-token   (v4 prod)
 *     authjs.session-token               (v5 dev / non-HTTPS)
 *
 * Two real problems surfaced on Codex Adversarial Review round 2 (PR #176):
 *
 *   1. Missing __Secure-authjs.session-token.
 *      NextAuth v5 emits this name over HTTPS (NOT __Secure-next-auth.*).
 *      In HTTPS prod, `auth()` accepted the new cookie but the middleware did
 *      not see it, so every protected route bounced to /auth/signin — admins
 *      were locked out after a successful OIDC sign-in. Also missing the
 *      __Host- variant some deployments prefer.
 *
 *   2. Chunked cookies are invisible to `cookies.get('name')`.
 *      When the session JWT exceeds the ~4KB per-cookie ceiling, Auth.js
 *      splits it into `<name>.0`, `<name>.1`, … `<name>.N`. A plain
 *      `req.cookies.get('__Secure-authjs.session-token')` returns undefined
 *      for chunked sessions and we redirect a logged-in admin.
 *
 * ---------------------------------------------------------------------------
 * Why not the `auth()` wrapper (the more elegant fix)
 * ---------------------------------------------------------------------------
 *
 * The "right" v5 fix is:
 *
 *     import { auth } from './lib/auth.js';
 *     export default auth((req) => { ... });
 *
 * which delegates cookie discovery to NextAuth itself. We do NOT do this
 * here, intentionally, because:
 *
 *   - Middleware runs on the Edge runtime.
 *   - `./lib/auth.js` transitively imports `appUsersRepo` and `tenantsRepo`
 *     from `../../db/repositories.js`, which import `drizzle-orm/node-postgres`
 *     and `pg`. `pg` uses Node's `net`/`tls`/`dns` — none of which exist on
 *     the Edge runtime. Bundling auth.ts into the middleware bundle fails at
 *     `next build`.
 *   - Adopting the wrapper cleanly requires a `auth.config.ts` / `auth.ts`
 *     split (edge-safe config in one file, full callbacks + adapter in
 *     another). That refactor touches `lib/auth.ts`, which is OUT OF SCOPE
 *     for issue #179 (see PR scope note).
 *
 * So we keep the hand-rolled cookie gate, but make it complete: every cookie
 * name Auth.js v5 (and v4 for back-compat) might use, plus the chunked
 * variants — see ./middleware-cookie.ts for the predicate and the testable
 * helpers.
 *
 * If/when `lib/auth.ts` is split into edge-safe + node-only halves, this file
 * should collapse back into the `auth()` wrapper and this comment can go.
 */
import { NextRequest, NextResponse } from 'next/server';
import { hasSessionCookie, isPublicPath } from './middleware-cookie.js';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths through
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!hasSessionCookie(req.cookies.getAll())) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
