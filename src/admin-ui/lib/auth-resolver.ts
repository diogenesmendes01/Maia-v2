/**
 * P8.5 — OIDC app-user resolver.
 *
 * Lives in its own module (NextAuth-free) so unit tests can verify resolution
 * WITHOUT loading `next-auth` (which is installed only inside
 * `src/admin-ui/node_modules/`, NOT at the repo root where the root vitest job
 * runs). This mirrors the precedent set by `./auth-gating.ts`.
 *
 * The actual NextAuth config (./auth.ts) imports and delegates to this module,
 * so both surfaces share one source of truth.
 *
 * Why a separate module instead of vitest aliases for `next-auth`:
 *   The root `package.json` does not depend on `next-auth`; the dependency
 *   lives only in `src/admin-ui/package.json`. A fresh `npm ci` at the repo
 *   root (as the CI validate job does) does not install it. Aliasing
 *   `next-auth` to a stub at the root vitest config would couple the test
 *   harness to a fake module that doesn't reflect what production uses; an
 *   extracted resolver module avoids that coupling entirely.
 *
 * Fail-closed posture summary — see `./auth.ts` module-level comment for the
 * full design rationale around ambiguity rejection (issue #164).
 */
import { appUsersRepo, tenantsRepo } from '../../db/repositories.js';
import { KNOWN_ROLES } from './auth-gating.js';

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
 *
 * Slug parsing dedupes after trim/filter (Codex review on PR #170 [P2]):
 *   If OIDC_TENANT_SLUGS contains the same slug twice (e.g. `acme,acme` from
 *   a config typo / templating bug), the raw split-and-filter array keeps
 *   both entries. Without dedupe the loop would query the same app_users row
 *   twice and push two identical candidates, falsely tripping the
 *   `candidates.length > 1` ambiguity check and rejecting a single-tenant
 *   sign-in. Dedupe via `new Set(...)` before iterating restores the
 *   intended semantics.
 */
export async function resolveOidcAppUser(
  email: string,
  deps: ResolveOidcAppUserDeps = DEFAULT_RESOLVE_OIDC_DEPS,
): Promise<{
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
} | null> {
  const rawSlugs = (process.env.OIDC_TENANT_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Dedupe to avoid false ambiguity when the same slug appears twice in env
  // (Codex review on PR #170 [P2]). Preserves first-seen order for stable
  // log output.
  const tenantSlugs = Array.from(new Set(rawSlugs));
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
