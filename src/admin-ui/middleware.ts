/**
 * P8.5 — Next.js middleware. Route-level protection.
 *
 * Public routes: /auth/*, /api/auth/*, _next/*. Everything else requires
 * a NextAuth session cookie. Tenant assertion happens at the tRPC layer
 * (see ./trpc/context.ts).
 */
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/auth/signin', '/auth/error', '/api/auth', '/_next', '/favicon.ico'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for NextAuth session cookie. v5 uses `__Secure-` prefix in prod.
  const sessionCookie =
    req.cookies.get('next-auth.session-token')?.value ??
    req.cookies.get('__Secure-next-auth.session-token')?.value ??
    req.cookies.get('authjs.session-token')?.value;

  if (!sessionCookie) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
