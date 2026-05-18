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
