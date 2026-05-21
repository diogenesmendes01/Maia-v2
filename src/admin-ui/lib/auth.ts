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
import { appUsersRepo, tenantsRepo } from '../../db/repositories.js';
import {
  KNOWN_ROLES,
  timingSafeEqual,
  devCredentialsProviderEnabled,
  oidcProviderEnabled,
  resolveSecret,
} from './auth-gating.js';

function buildProviders(): NextAuthConfig['providers'] {
  const providers: NextAuthConfig['providers'] = [];

  // Production-grade OIDC provider. Registers in ANY environment if
  // OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET are configured. Works
  // with any compliant OIDC IdP — Auth0, Okta, Azure AD, Keycloak, etc.
  if (oidcProviderEnabled()) {
    providers.push({
      id: 'oidc',
      name: 'SSO',
      type: 'oidc' as const,
      issuer: process.env.OIDC_ISSUER!,
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,
      authorization: { params: { scope: 'openid email profile' } },
      // Trust the IdP for verified-email — authorization is then enforced in
      // the signIn callback against app_users.
    });
  }

  if (!devCredentialsProviderEnabled()) {
    // No dev provider — return whatever OIDC contributed (possibly empty,
    // which is fail-closed if no IdP is configured).
    return providers;
  }

  providers.push(
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
  );

  return providers;
}

/**
 * Resolve an OIDC sign-in to an app_users row. The OIDC provider gives us a
 * verified email; we look it up across every configured tenant slug supplied
 * in env `OIDC_TENANT_SLUGS` (comma-separated).
 *
 * Resolution rules (fail-closed):
 *   1. Enumerate EVERY allowed tenant — we do not return on the first match.
 *      This is required to detect ambiguous bindings (see #2).
 *   2. AMBIGUOUS-TENANT REJECTION (issue #164, Codex adversarial round 3 on
 *      PR #163 → originally introduced by PR #162):
 *        The `app_users` table is only unique on (tenant_id, email). The same
 *        email can legitimately exist in multiple tenants. Under a real OIDC
 *        IdP wired against `OIDC_TENANT_SLUGS=acme,foundry,demo`, the previous
 *        "first match wins" strategy would silently bind the user to whichever
 *        tenant appeared first in the env list — a tenant-isolation failure.
 *        Hard policy: if the (verified, known-role, active-tenant) candidate
 *        set has size > 1, reject the sign-in entirely (return null → NextAuth
 *        surfaces AccessDenied). The user must be explicitly disambiguated at
 *        the IdP / app_users level before sign-in is allowed.
 *   3. Per-candidate guards stay as before:
 *        - email_verified must be set
 *        - role must be in KNOWN_ROLES
 *        - non-founders cannot sign in to a non-active tenant
 *
 * Why an env list instead of just `email`? Maia is multi-tenant: the same
 * email could (in principle) appear in multiple tenants. The env list pins
 * which tenants the OIDC pool can authenticate into. For a single-tenant
 * deployment set OIDC_TENANT_SLUGS=acme — that case avoids the ambiguity trap
 * by construction.
 */
export type ResolveOidcAppUserDeps = {
  appUsersRepo: Pick<typeof appUsersRepo, 'getByEmail'>;
  tenantsRepo: Pick<typeof tenantsRepo, 'findById'>;
  /** Pluggable logger. Defaults to console; tests can inject a spy. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

const DEFAULT_RESOLVE_OIDC_DEPS: ResolveOidcAppUserDeps = {
  appUsersRepo,
  tenantsRepo,
  logger: { warn: (msg, meta) => console.warn(msg, meta ?? {}) },
};

export async function resolveOidcAppUser(
  email: string,
  deps: ResolveOidcAppUserDeps = DEFAULT_RESOLVE_OIDC_DEPS,
): Promise<{
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
} | null> {
  const tenantSlugs = (process.env.OIDC_TENANT_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tenantSlugs.length === 0) return null;

  const candidates: Array<{
    tenant: string;
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  }> = [];

  for (const tenant of tenantSlugs) {
    const user = await deps.appUsersRepo.getByEmail(tenant, email);
    if (!user) continue;
    if (!user.email_verified) continue;
    if (!user.role || !KNOWN_ROLES.has(user.role)) continue;
    // Codex review #162: refuse OIDC sign-in into a suspended tenant. Founders
    // get a sign-in path via the dev provider (where applicable) for recovery
    // operations; here we keep the same posture as protectedProcedure.
    if (user.role !== 'founder') {
      const tenantRow = await deps.tenantsRepo.findById(tenant);
      if (!tenantRow || tenantRow.status !== 'active') continue;
    }
    candidates.push({
      tenant,
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
    });
  }

  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    // Issue #164 — fail-closed under ambiguity. Log the matched tenants for
    // operator investigation; we deliberately do NOT log the email (it's
    // attacker-controlled IdP input at this point).
    const logger = deps.logger ?? DEFAULT_RESOLVE_OIDC_DEPS.logger!;
    logger.warn(
      '[admin-ui/auth] OIDC sign-in rejected: email matches multiple allowed tenants (ambiguous binding)',
      {
        tenant_count: candidates.length,
        tenants: candidates.map((c) => c.tenant),
      },
    );
    return null;
  }

  const only = candidates[0]!;
  return {
    id: only.id,
    email: only.email,
    name: only.name,
    image: only.image,
  };
}

// v5 NextAuthConfig (replaces v4 NextAuthOptions).
const authConfig: NextAuthConfig = {
  providers: buildProviders(),
  callbacks: {
    /**
     * Authorization gate after authentication. For the OIDC provider:
     *
     *   1. The IdP MUST emit `email_verified === true` in the profile/ID-token.
     *      Without this guard, a misconfigured IdP that lets any email pass
     *      through unverified would let an attacker bind to any admin account
     *      we have an app_users row for (Codex review #162 round 2,
     *      [critical]).
     *   2. We resolve authorization against app_users (verified email there +
     *      known role + tenant pinned by OIDC_TENANT_SLUGS + tenant.status =
     *      active for non-founders).
     *   3. If either gate fails, returning `false` makes NextAuth surface
     *      AccessDenied — no session is created.
     *
     * For the dev Magic-Link CredentialsProvider, `authorize()` already
     * returned an id-bearing user from app_users, so we pass through.
     */
    async signIn({ account, user, profile }) {
      if (account?.provider === 'oidc') {
        // Read the verified-email claim from the IdP. `profile.email_verified`
        // is the canonical OIDC core claim; some providers also surface
        // boolean-looking strings — accept both true and 'true'.
        const verified = (profile as { email_verified?: boolean | string } | undefined)
          ?.email_verified;
        const emailVerified = verified === true || verified === 'true';
        if (!emailVerified) return false;

        const email = (user?.email ?? '').toLowerCase().trim();
        if (!email) return false;
        const appUser = await resolveOidcAppUser(email);
        if (!appUser) return false;
        // Mutate the user object so the jwt callback picks up the resolved id.
        // NextAuth v5 keeps the user reference between signIn → jwt for the
        // initial sign-in.
        (user as { id?: string }).id = appUser.id;
        return true;
      }
      return true;
    },

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
  oidcProviderEnabled,
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
