/**
 * P8.5 — Auth gating logic (post Codex review #101).
 *
 * Lives in its own module so unit tests can verify gating WITHOUT loading
 * `next-auth/providers/credentials` (which requires the admin-ui's local
 * node_modules to be installed — not the case for `vitest run` from repo root).
 *
 * The actual NextAuth config (./auth.ts) imports + delegates to these helpers,
 * so both surfaces share one source of truth.
 *
 * Fail-closed posture summary — see ./auth.ts module-level comment for the
 * full design rationale.
 */

export const KNOWN_ROLES = new Set([
  'founder',
  'compliance_officer',
  'owner',
  'analyst',
  'viewer',
]);

/**
 * Constant-time string comparison. Avoids leaking match-prefix-length through
 * short-circuit evaluation in the dev login token check.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns true only when the dev-only CredentialsProvider should be registered.
 * Reads from process.env at call time so tests can flip env vars in-process.
 */
export function devCredentialsProviderEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.FEATURE_ADMIN_UI_V1 !== 'true') return false;
  if (process.env.ALLOW_DEV_AUTH !== 'true') return false;
  const token = process.env.ADMIN_UI_DEV_LOGIN_TOKEN ?? '';
  if (token.length < 16) return false;
  return true;
}

/**
 * Returns true when the production OIDC provider should be registered.
 *
 * Requires all of:
 *   - OIDC_ISSUER         (e.g. https://login.example.com/realms/maia)
 *                          MUST be https:// in production. In dev/test, plain
 *                          http:// is only tolerated for the loopback hosts
 *                          `localhost` and `127.0.0.1` (any port) so operators
 *                          can stand up a local IdP. Anything else (incl.
 *                          private RFC1918 IPs over http) is rejected — see
 *                          issue #167 (cleartext OIDC in prod) for rationale.
 *   - OIDC_CLIENT_ID
 *   - OIDC_CLIENT_SECRET  (>= 16 chars; rejecting empty/placeholder)
 *   - OIDC_TENANT_SLUGS   (non-empty comma list; without this every OIDC
 *                          sign-in resolves to no app_users row and returns
 *                          AccessDenied — better to not register the provider
 *                          at all than to expose a broken SSO button).
 *
 * The provider issues a JWT-backed session whose `email` claim is matched
 * against `app_users` rows. A user without a matching app_users row (with
 * email_verified set and a known role) cannot complete sign-in — keeping
 * authorization fail-closed even after authentication succeeds.
 *
 * Works in any NODE_ENV (development as well, for local OIDC testing).
 *
 * Fail-mode contract (Codex Adversarial Review on PR #168):
 *
 *   - `OIDC_ISSUER` empty/unset
 *       → "not configured" → returns `false` silently (intentional: many
 *         deployments don't run OIDC, the dev CredentialsProvider covers them).
 *   - `OIDC_ISSUER` set but INVALID (unparseable, wrong scheme, cleartext)
 *       in `NODE_ENV === 'production'`
 *       → "configured but broken" → THROWS with a descriptive message so the
 *         admin-ui crashes at startup rather than silently dropping the only
 *         production auth provider and leaving operators with a generic
 *         "no providers configured" screen.
 *   - `OIDC_ISSUER` set but INVALID in dev/test
 *       → returns `false` silently. Test suites and local dev frequently
 *         exercise the invalid-config branches; we don't want to crash them.
 */
export function oidcProviderEnabled(): boolean {
  const issuer = process.env.OIDC_ISSUER ?? '';
  const clientId = process.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? '';
  const tenantSlugs = (process.env.OIDC_TENANT_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Empty/unset issuer = "OIDC not configured for this deployment". Always
  // silent: this is the expected state for any non-OIDC install.
  if (!issuer) return false;

  const isProd = process.env.NODE_ENV === 'production';

  // Validate parseability. `new URL` throws TypeError for malformed input —
  // in prod that's a misconfiguration we MUST surface; in dev we tolerate it.
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    if (isProd) {
      throw new Error(
        `P8.5 auth: OIDC_ISSUER is set but is not a valid URL ` +
          `(received: ${JSON.stringify(issuer)}). ` +
          `Refusing to boot — set OIDC_ISSUER to a parseable https:// URL ` +
          `or unset it entirely to disable the OIDC provider. See issue #167.`,
      );
    }
    return false;
  }

  if (isProd) {
    // Production: https:// only. No exceptions — cleartext leaks redirect
    // URLs, ID tokens, and client credentials to any network observer.
    // Fail-fast (not silent) so a typo in OIDC_ISSUER doesn't quietly remove
    // the only production auth provider and surface as "no providers".
    if (url.protocol !== 'https:') {
      throw new Error(
        `P8.5 auth: OIDC_ISSUER must use https:// in production ` +
          `(received protocol: ${url.protocol.replace(':', '')}://, ` +
          `issuer: ${issuer}). ` +
          `Refusing to boot — cleartext OIDC leaks redirect URLs, ID tokens, ` +
          `and client credentials to any on-path observer. ` +
          `Either set OIDC_ISSUER to an https:// URL or unset it entirely ` +
          `to disable the OIDC provider. See issue #167.`,
      );
    }
  } else {
    // Dev/test: https:// always OK; http:// only for loopback hosts so a
    // local IdP (Keycloak, dex, etc.) can be exercised without TLS.
    const isLoopbackHttp =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !isLoopbackHttp) return false;
  }
  if (!clientId) return false;
  if (clientSecret.length < 16) return false;
  if (tenantSlugs.length === 0) return false;
  return true;
}

/**
 * Resolve the runtime secret. Throws in production if NEXTAUTH_SECRET is too
 * weak (defense in depth — NextAuth itself doesn't enforce a length minimum).
 */
export function resolveSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!secret || secret.length < 32) {
      throw new Error(
        'P8.5 auth: NEXTAUTH_SECRET must be set to a >=32-char value in production. ' +
          'Refusing to boot with a weak/default secret.',
      );
    }
    return secret;
  }
  return secret ?? 'dev-secret-change-in-prod';
}
