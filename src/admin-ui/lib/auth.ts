/**
 * P8.5 — NextAuth v5 (auth.js) configuration.
 *
 * SECURITY POSTURE (post Codex review #101 round-2):
 *
 *   Production:
 *     - NEXTAUTH_SECRET / AUTH_SECRET must be set (>= 32 chars). Boot fails
 *       otherwise.
 *     - The magic-link CredentialsProvider is NOT registered. There is no
 *       email-only sign-in path. OIDC/SAML must be wired (deferred to P10);
 *       until then, production sign-in returns "no providers configured".
 *
 *   Development / staging (NODE_ENV !== 'production'):
 *     - The magic-link CredentialsProvider is registered ONLY if BOTH:
 *         (a) FEATURE_ADMIN_UI_V1 === true
 *         (b) ALLOW_DEV_AUTH === true
 *       AND a shared-secret token is set in ADMIN_UI_DEV_LOGIN_TOKEN (>= 16
 *       chars). The provider then:
 *         - rejects requests where the supplied `token` does not match
 *         - requires the user row to have `email_verified` set
 *         - requires the user row to have a known role
 *         - requires the supplied tenantId to match the user row's tenant_id
 *
 *   In other words: knowing an admin email is no longer sufficient to obtain
 *   an authenticated session. The dev path requires (token + email_verified +
 *   tenant match + feature flag + dev-auth flag), all of which require shell
 *   access to the deployment to configure.
 *
 * REVIEW REFERENCE:
 *   - round-1 finding: "[critical] Email-only credentials provider lets anyone
 *     impersonate admins" — fixed in round-1.
 *   - round-2 finding: "[critical] Auth route exports wrong NextAuth v5 object"
 *     — fixed here: v4 NextAuthOptions → v5 NextAuthConfig; exports { handlers,
 *     auth }; consumers call auth() instead of getServerSession(authOptions).
 *
 * v5 MIGRATION NOTES:
 *   - `NextAuthOptions` (v4) → `NextAuthConfig` (v5).
 *   - `authOptions` removed; `auth` is the universal session accessor.
 *   - Route handler exports `handlers.GET` / `handlers.POST`.
 *   - Server components / tRPC context use `auth()` (no args) instead of
 *     `getServerSession(authOptions)`.
 *   - JWT callback signature: `user` is always present on initial sign-in.
 */
import NextAuth from 'next-auth';
import type { NextAuthConfig, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import CredentialsProvider from 'next-auth/providers/credentials';
import { appUsersRepo } from '../../db/repositories.js';
import {
  KNOWN_ROLES,
  timingSafeEqual,
  devCredentialsProviderEnabled,
  resolveSecret,
} from './auth-gating.js';

function buildProviders(): NextAuthConfig['providers'] {
  if (!devCredentialsProviderEnabled()) {
    // Fail-closed: no providers. NextAuth will refuse sign-in until OIDC/SAML
    // is wired (P10). This is intentional — see module-level comment.
    return [];
  }

  return [
    CredentialsProvider({
      id: 'magic-link',
      name: 'Magic Link (dev only)',
      credentials: {
        email: { label: 'Email', type: 'text' },
        token: { label: 'Token', type: 'text' },
        tenantId: { label: 'Tenant', type: 'text' },
      },
      async authorize(credentials) {
        // Defense in depth: re-check at request time, in case env changed since boot.
        if (!devCredentialsProviderEnabled()) return null;

        if (!credentials?.email || !credentials?.tenantId || !credentials?.token) {
          return null;
        }

        const expectedToken = process.env.ADMIN_UI_DEV_LOGIN_TOKEN ?? '';
        if (!timingSafeEqual(String(credentials.token), expectedToken)) {
          return null;
        }

        const user = await appUsersRepo.getByEmail(
          String(credentials.tenantId),
          String(credentials.email),
        );
        if (!user) return null;

        // Reject unverified accounts. In dev seed scripts, set email_verified =
        // now() to bless an account for sign-in.
        if (!user.email_verified) return null;

        // Reject users with no/unknown role.
        if (!user.role || !KNOWN_ROLES.has(user.role)) return null;

        // Tenant supplied in credentials must match the user's tenant.
        if (user.tenant_id !== String(credentials.tenantId)) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
        };
      },
    }),
  ];
}

// v5 NextAuthConfig (replaces v4 NextAuthOptions).
const authConfig: NextAuthConfig = {
  providers: buildProviders(),
  callbacks: {
    async jwt({ token, user }: { token: JWT; user?: { id?: string } }) {
      if (user?.id) {
        // Always re-derive role + tenant_id from the DB row, never trust the
        // session bootstrap claims. Prevents a malicious client from supplying
        // fake claims through the credentials object.
        const dbUser = await appUsersRepo.getById(user.id);
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.tenant_id = dbUser.tenant_id;
        }
      }
      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? '';
        session.user.role = (token.role as string) ?? '';
        session.user.tenant_id = (token.tenant_id as string) ?? '';
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  secret: resolveSecret(),
};

/**
 * `handlers` — Next.js App Router route handlers (GET/POST).
 * `auth`     — universal session accessor. Call as `auth()` (no args) in server
 *              components, tRPC context, and middleware to get the active Session
 *              (replaces v4's `getServerSession(authOptions)`).
 */
export const { handlers, auth } = NextAuth(authConfig);

/**
 * Test-only re-exports. These are NOT part of the public API surface; they
 * exist so unit tests can drive the gating logic without spinning up NextAuth.
 *
 * Direct imports of `./auth-gating.js` are preferred for unit tests so the
 * test file doesn't transitively load next-auth.
 */
export const __testing = {
  devCredentialsProviderEnabled,
  timingSafeEqual,
  KNOWN_ROLES,
};

// Module augmentation: extend the default Session.user shape with our
// tenant + role fields. NextAuth v5 supports declaration merging.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
      role: string;
      tenant_id: string;
    };
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
    tenant_id?: string;
  }
}
