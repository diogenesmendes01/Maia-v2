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
 * Fail-mode contract (Codex Adversarial Review on PR #168, rounds 1 & 2):
 *
 *   - `OIDC_ISSUER` empty/unset
 *       → "not configured" → returns `false` silently (intentional: many
 *         deployments don't run OIDC, the dev CredentialsProvider covers them).
 *         This is the ONLY silent-false branch in production. Round 2 hardened
 *         the contract so that "OIDC_ISSUER set + any other var missing/weak"
 *         can no longer drop the provider silently.
 *   - `OIDC_ISSUER` set but INVALID (unparseable, wrong scheme, cleartext)
 *       in `NODE_ENV === 'production'`
 *       → "configured but broken" → THROWS with a descriptive message so the
 *         admin-ui crashes at startup rather than silently dropping the only
 *         production auth provider and leaving operators with a generic
 *         "no providers configured" screen.
 *   - `OIDC_ISSUER` set (valid https://) but `OIDC_CLIENT_ID`,
 *     `OIDC_CLIENT_SECRET`, or `OIDC_TENANT_SLUGS` missing/empty/weak
 *       in `NODE_ENV === 'production'`
 *       → "partially configured" → THROWS (Codex round 2). Reasoning: in
 *         production, the dev CredentialsProvider is disabled — a silent
 *         `false` here would register zero providers and present operators
 *         with the same opaque "no providers configured" screen the round-1
 *         fail-fast was meant to prevent. The secret never appears in the
 *         error message; only its length is reported.
 *   - `OIDC_ISSUER` set but INVALID in dev/test
 *       → returns `false` silently. Test suites and local dev frequently
 *         exercise the invalid-config branches; we don't want to crash them.
 *
 * `MIN_OIDC_CLIENT_SECRET_LEN` (16 chars) is the same threshold used by
 * `devCredentialsProviderEnabled` for `ADMIN_UI_DEV_LOGIN_TOKEN`. It's
 * intentionally modest — 16 random chars is a hard floor against trivially
 * guessable placeholders ("changeme", "secret", short paste artifacts) without
 * being so strict that it rejects values an upstream IdP may have generated
 * for us. Real OIDC client secrets from Keycloak/Auth0/etc. are typically
 * 32-64 chars and easily clear this bar.
 */
export const MIN_OIDC_CLIENT_SECRET_LEN = 16;
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

    // ISSUER is valid in prod — all other required vars must also be set,
    // otherwise we'd register no provider and produce the same opaque
    // "no providers configured" outage the round-1 fail-fast prevents.
    // (Codex Adversarial Review on PR #168, round 2.)
    if (!clientId) {
      throw new Error(
        `P8.5 auth: OIDC_ISSUER is set but OIDC_CLIENT_ID is empty/missing. ` +
          `Refusing to boot — a partially configured OIDC provider would ` +
          `register zero auth providers in production (dev CredentialsProvider ` +
          `is disabled in prod) and surface as a generic "no providers ` +
          `configured" screen. Set OIDC_CLIENT_ID, or unset OIDC_ISSUER ` +
          `entirely to disable the OIDC provider. See issue #167.`,
      );
    }
    if (clientSecret.length < MIN_OIDC_CLIENT_SECRET_LEN) {
      // NEVER include the secret value in the error message — only its length.
      // Length alone is enough to diagnose "I set a 6-char placeholder" vs.
      // "I set a real 48-char secret"; the value itself would leak into logs.
      throw new Error(
        `P8.5 auth: OIDC_ISSUER is set but OIDC_CLIENT_SECRET is missing or ` +
          `too short (length: ${clientSecret.length}, required: >=${MIN_OIDC_CLIENT_SECRET_LEN}). ` +
          `Refusing to boot — a partially configured OIDC provider would ` +
          `register zero auth providers in production and surface as a generic ` +
          `"no providers configured" screen. Set OIDC_CLIENT_SECRET to a ` +
          `random >=${MIN_OIDC_CLIENT_SECRET_LEN}-char value (typical IdP-issued secrets are 32-64 chars), ` +
          `or unset OIDC_ISSUER entirely to disable the OIDC provider. ` +
          `See issue #167.`,
      );
    }
    // Codex Adversarial Review round 3 on PR #176, [high]: the length guard
    // alone passes a long-but-public placeholder like the `changeme-...`
    // value shipped in `.env.example`. Re-use the placeholder rejection
    // already applied to NEXTAUTH_SECRET so an operator who forgets to
    // rotate doesn't boot prod with a publicly-known confidential-client
    // secret. The value itself is never echoed back — only the fact that
    // it matched a known pattern.
    if (isKnownPlaceholderSecret(clientSecret)) {
      throw new Error(
        `P8.5 auth: OIDC_CLIENT_SECRET matches a known placeholder pattern ` +
          `(starts with "changeme-", contains "changeme", "__PLACEHOLDER", ` +
          `"__SET_ME__", or "dev-secret-change-in-prod"). ` +
          `Refusing to boot — placeholders ship in \`.env.example\` and are ` +
          `publicly known, so a confidential-client OIDC secret using one is ` +
          `forgeable by anyone with read access to the repo. ` +
          `Rotate to a real IdP-issued secret (typically 32-64 random chars), ` +
          `or unset OIDC_ISSUER to disable the OIDC provider entirely. ` +
          `See PR #176 review.`,
      );
    }
    if (tenantSlugs.length === 0) {
      throw new Error(
        `P8.5 auth: OIDC_ISSUER is set but OIDC_TENANT_SLUGS is empty ` +
          `(received: ${JSON.stringify(process.env.OIDC_TENANT_SLUGS ?? '')}). ` +
          `Without a non-empty comma list of tenant slugs every OIDC sign-in ` +
          `resolves to no app_users row and returns AccessDenied. Refusing ` +
          `to boot — a partially configured OIDC provider would register ` +
          `zero auth providers in production and surface as a generic ` +
          `"no providers configured" screen. Set OIDC_TENANT_SLUGS to a ` +
          `comma-separated list (e.g. "acme,default"), or unset OIDC_ISSUER ` +
          `entirely to disable the OIDC provider. See issue #167.`,
      );
    }
    return true;
  }

  // Dev/test: https:// always OK; http:// only for loopback hosts so a
  // local IdP (Keycloak, dex, etc.) can be exercised without TLS.
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLoopbackHttp) return false;
  if (!clientId) return false;
  if (clientSecret.length < MIN_OIDC_CLIENT_SECRET_LEN) return false;
  if (tenantSlugs.length === 0) return false;
  return true;
}

/**
 * Known placeholder patterns we ship in `.env.example` (and that operators
 * commonly leave in place during a copy-and-tweak workflow). Even when these
 * pass the >=32 char length guard they are PUBLIC strings — a deployment
 * using one of them has a session-signing secret that anyone with read
 * access to the repo can forge. We reject them outright in production.
 *
 * Match heuristics, in order of specificity:
 *   1. The exact `.env.example` placeholder (`changeme-generate-with-...`).
 *   2. The legacy dev fallback (`dev-secret-change-in-prod`).
 *   3. Any value containing `changeme`, `change-me`, `change_me`,
 *      `__PLACEHOLDER`, or `__SET_ME__` (case-insensitive).
 *
 * Keep the list short and specific — too-aggressive heuristics would falsely
 * reject high-entropy operator secrets that happen to share a substring.
 */
const KNOWN_PLACEHOLDER_PATTERNS = [
  /^changeme-/i,
  /change-?me/i,
  /change_me/i,
  /__PLACEHOLDER/i,
  /__SET_ME__/i,
  // The legacy dev fallback is 25 chars and is normally caught by the
  // length guard. Substring match (not just the exact 25-char string) so a
  // deliberately-padded version (`dev-secret-change-in-prod-pad-to-32-chars`)
  // is still rejected.
  /dev-secret-change-in-prod/i,
];

function isKnownPlaceholderSecret(value: string): boolean {
  return KNOWN_PLACEHOLDER_PATTERNS.some((rx) => rx.test(value));
}

/**
 * Resolve the runtime secret. Throws in production if NEXTAUTH_SECRET is too
 * weak (defense in depth — NextAuth itself doesn't enforce a length minimum).
 *
 * Codex Adversarial Review on PR #176, [critical]: also rejects known
 * placeholder values that pass the length guard but are public strings
 * (`.env.example` ships a 56-char `changeme-...` line that would otherwise
 * boot prod silently with a forgeable session secret).
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
    if (isKnownPlaceholderSecret(secret)) {
      throw new Error(
        'P8.5 auth: NEXTAUTH_SECRET matches a known placeholder pattern ' +
          '(starts with "changeme-", contains "changeme", "__PLACEHOLDER", ' +
          '"__SET_ME__", or equals "dev-secret-change-in-prod"). ' +
          'Refusing to boot — placeholders ship in `.env.example` and are ' +
          'publicly known, so a session-signing secret using one is forgeable ' +
          'by anyone with read access to the repo. ' +
          'Generate a fresh one: `openssl rand -base64 48`. ' +
          'See Codex review on PR #176.',
      );
    }
    return secret;
  }
  return secret ?? 'dev-secret-change-in-prod';
}
