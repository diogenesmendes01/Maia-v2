/**
 * P8.5 — Auth gating unit tests (post Codex review #101).
 *
 * Verifies that the magic-link CredentialsProvider is FAIL-CLOSED. Specifically:
 *   - Production (NODE_ENV=production) ⇒ provider disabled, irrespective of flags.
 *   - Missing/short ADMIN_UI_DEV_LOGIN_TOKEN ⇒ provider disabled.
 *   - Missing FEATURE_ADMIN_UI_V1 ⇒ provider disabled.
 *   - Missing ALLOW_DEV_AUTH ⇒ provider disabled.
 *   - The timing-safe token compare doesn't short-circuit on prefix match.
 *
 * Pre-Codex-review state was: any email + any tenant + any token → authenticated.
 * Each negative test below would have FALSELY PASSED that version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  devCredentialsProviderEnabled,
  oidcProviderEnabled,
  timingSafeEqual,
  KNOWN_ROLES,
  resolveSecret,
} from '@/admin-ui/lib/auth-gating.js';

const SAVED_ENV: Record<string, string | undefined> = {};

const TOGGLES = [
  'NODE_ENV',
  'FEATURE_ADMIN_UI_V1',
  'ALLOW_DEV_AUTH',
  'ADMIN_UI_DEV_LOGIN_TOKEN',
  'NEXTAUTH_SECRET',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_TENANT_SLUGS',
] as const;

function snapshotEnv() {
  for (const k of TOGGLES) SAVED_ENV[k] = process.env[k];
}
function restoreEnv() {
  for (const k of TOGGLES) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function setEnabledEnv() {
  process.env.NODE_ENV = 'development';
  process.env.FEATURE_ADMIN_UI_V1 = 'true';
  process.env.ALLOW_DEV_AUTH = 'true';
  process.env.ADMIN_UI_DEV_LOGIN_TOKEN = 'sufficiently-long-dev-token-1234567890';
}

beforeEach(snapshotEnv);
afterEach(restoreEnv);

describe('devCredentialsProviderEnabled — gating', () => {
  it('all four conditions met ⇒ enabled', () => {
    setEnabledEnv();
    expect(devCredentialsProviderEnabled()).toBe(true);
  });

  it('NODE_ENV=production ⇒ DISABLED even with all other flags set', () => {
    setEnabledEnv();
    process.env.NODE_ENV = 'production';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('FEATURE_ADMIN_UI_V1 unset ⇒ disabled', () => {
    setEnabledEnv();
    delete process.env.FEATURE_ADMIN_UI_V1;
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('FEATURE_ADMIN_UI_V1=false ⇒ disabled', () => {
    setEnabledEnv();
    process.env.FEATURE_ADMIN_UI_V1 = 'false';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('ALLOW_DEV_AUTH unset ⇒ disabled', () => {
    setEnabledEnv();
    delete process.env.ALLOW_DEV_AUTH;
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('ALLOW_DEV_AUTH=false ⇒ disabled (this is the production default)', () => {
    setEnabledEnv();
    process.env.ALLOW_DEV_AUTH = 'false';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('ADMIN_UI_DEV_LOGIN_TOKEN unset ⇒ disabled', () => {
    setEnabledEnv();
    delete process.env.ADMIN_UI_DEV_LOGIN_TOKEN;
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('ADMIN_UI_DEV_LOGIN_TOKEN < 16 chars ⇒ disabled', () => {
    setEnabledEnv();
    process.env.ADMIN_UI_DEV_LOGIN_TOKEN = 'short';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('ADMIN_UI_DEV_LOGIN_TOKEN === "" ⇒ disabled', () => {
    setEnabledEnv();
    process.env.ADMIN_UI_DEV_LOGIN_TOKEN = '';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  // REGRESSION GUARDS — these would all have PASSED in the broken version that
  // accepted any email + any token + any tenant.
  it('REGRESSION: only an email + tenantId ⇒ provider still disabled', () => {
    delete process.env.FEATURE_ADMIN_UI_V1;
    delete process.env.ALLOW_DEV_AUTH;
    delete process.env.ADMIN_UI_DEV_LOGIN_TOKEN;
    expect(devCredentialsProviderEnabled()).toBe(false);
  });

  it('REGRESSION: NODE_ENV=production + every flag set ⇒ provider STILL disabled', () => {
    setEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.FEATURE_ADMIN_UI_V1 = 'true';
    process.env.ALLOW_DEV_AUTH = 'true';
    process.env.ADMIN_UI_DEV_LOGIN_TOKEN = 'production-cannot-be-bypassed-this-way';
    expect(devCredentialsProviderEnabled()).toBe(false);
  });
});

describe('oidcProviderEnabled — gating', () => {
  function setOidcEnabledEnv() {
    process.env.OIDC_ISSUER = 'https://login.example.com/realms/maia';
    process.env.OIDC_CLIENT_ID = 'maia-admin';
    process.env.OIDC_CLIENT_SECRET = 'NOT_A_REAL_SECRET_ok_for_unit_test_only_xx';
    process.env.OIDC_TENANT_SLUGS = 'acme,default';
  }

  it('all three env set ⇒ enabled', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    expect(oidcProviderEnabled()).toBe(true);
  });

  it('works in production too (no NODE_ENV gating)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    expect(oidcProviderEnabled()).toBe(true);
  });

  it('DEV: OIDC_ISSUER without http(s) prefix ⇒ disabled (silent in dev)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'login.example.com';
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_ISSUER unset ⇒ disabled', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    delete process.env.OIDC_ISSUER;
    expect(oidcProviderEnabled()).toBe(false);
  });

  // Issue #167 — cleartext OIDC issuer must be rejected in production. The
  // pre-fix gate only checked `startsWith('http')` which also matched http://.
  // Misconfigured OIDC_ISSUER=http://... in prod would have registered the
  // provider, leaking redirect URLs, ID tokens, and client credentials.
  //
  // Codex Adversarial Review on PR #168: in production, an INVALID issuer
  // must FAIL-FAST (throw) instead of silently returning false. A silent
  // false here removes the only production auth provider and surfaces as a
  // generic "no providers configured" screen — operators can't tell whether
  // OIDC was intentionally unconfigured or accidentally misconfigured.
  it('PROD: OIDC_ISSUER=http:// ⇒ THROWS (cleartext rejected, fail-fast)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'http://idp.internal/realms/maia';
    expect(() => oidcProviderEnabled()).toThrow(
      /OIDC_ISSUER must use https:\/\/ in production/,
    );
    // Message must surface the offending protocol AND the issuer value so
    // an operator reading the crash log can immediately see what was set.
    expect(() => oidcProviderEnabled()).toThrow(/http:\/\//);
    expect(() => oidcProviderEnabled()).toThrow(/idp\.internal/);
  });

  it('PROD: OIDC_ISSUER=http://localhost ⇒ THROWS (no loopback exception in prod)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'http://localhost:8080/realms/maia';
    expect(() => oidcProviderEnabled()).toThrow(
      /OIDC_ISSUER must use https:\/\/ in production/,
    );
  });

  it('PROD: OIDC_ISSUER malformed (unparseable) ⇒ THROWS (fail-fast, descriptive)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'not-a-url';
    expect(() => oidcProviderEnabled()).toThrow(
      /OIDC_ISSUER is set but is not a valid URL/,
    );
    // The bad value should be in the error message so operators can spot it.
    expect(() => oidcProviderEnabled()).toThrow(/not-a-url/);
  });

  it('PROD: OIDC_ISSUER=ftp:// ⇒ THROWS (unsupported scheme rejected)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'ftp://idp.example.com/realms/maia';
    expect(() => oidcProviderEnabled()).toThrow(
      /OIDC_ISSUER must use https:\/\/ in production/,
    );
  });

  it('PROD: OIDC_ISSUER unset ⇒ false silently (NOT throw — "not configured" is OK)', () => {
    // Distinguishes "OIDC not configured" (silent) from "OIDC configured but
    // invalid" (throws). Many prod deployments run without OIDC; we must not
    // crash them just because the env var is absent.
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    delete process.env.OIDC_ISSUER;
    expect(() => oidcProviderEnabled()).not.toThrow();
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('PROD: OIDC_ISSUER="" ⇒ false silently (empty == not configured)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = '';
    expect(() => oidcProviderEnabled()).not.toThrow();
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('PROD: OIDC_ISSUER=https:// ⇒ enabled', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'production';
    process.env.OIDC_ISSUER = 'https://idp.internal/realms/maia';
    expect(() => oidcProviderEnabled()).not.toThrow();
    expect(oidcProviderEnabled()).toBe(true);
  });

  it('DEV: OIDC_ISSUER=http://localhost:8080 ⇒ enabled (local IdP testing)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'http://localhost:8080/realms/maia';
    expect(oidcProviderEnabled()).toBe(true);
  });

  it('DEV: OIDC_ISSUER=http://127.0.0.1 ⇒ enabled (loopback IP)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'http://127.0.0.1:8080/realms/maia';
    expect(oidcProviderEnabled()).toBe(true);
  });

  it('DEV: OIDC_ISSUER=http://192.168.1.10 ⇒ disabled (non-loopback http rejected)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'http://192.168.1.10/realms/maia';
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('DEV: OIDC_ISSUER=http://idp.internal ⇒ disabled (non-loopback hostname)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'http://idp.internal/realms/maia';
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('DEV: OIDC_ISSUER malformed (unparseable) ⇒ disabled (no throw, silent in dev)', () => {
    // Dev/test preserves the silent fail-closed behavior so local iteration
    // and unit tests that intentionally exercise invalid configs don't crash.
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'not a url ::::';
    expect(() => oidcProviderEnabled()).not.toThrow();
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('DEV: OIDC_ISSUER with unsupported scheme (e.g. ftp://) ⇒ disabled (silent)', () => {
    setOidcEnabledEnv();
    process.env.NODE_ENV = 'development';
    process.env.OIDC_ISSUER = 'ftp://idp.example.com/realms/maia';
    expect(() => oidcProviderEnabled()).not.toThrow();
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_CLIENT_ID unset ⇒ disabled', () => {
    setOidcEnabledEnv();
    delete process.env.OIDC_CLIENT_ID;
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_CLIENT_SECRET < 16 chars ⇒ disabled (weak secret guard)', () => {
    setOidcEnabledEnv();
    process.env.OIDC_CLIENT_SECRET = 'short';
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_CLIENT_SECRET unset ⇒ disabled', () => {
    setOidcEnabledEnv();
    delete process.env.OIDC_CLIENT_SECRET;
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_TENANT_SLUGS unset ⇒ disabled (prevents SSO-but-AccessDenied UX)', () => {
    setOidcEnabledEnv();
    delete process.env.OIDC_TENANT_SLUGS;
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('OIDC_TENANT_SLUGS empty/whitespace ⇒ disabled', () => {
    setOidcEnabledEnv();
    process.env.OIDC_TENANT_SLUGS = ' , , ';
    expect(oidcProviderEnabled()).toBe(false);
  });

  it('none of the env vars set ⇒ disabled (no accidental enable)', () => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_TENANT_SLUGS;
    expect(oidcProviderEnabled()).toBe(false);
  });
});

describe('timingSafeEqual — no prefix-match short-circuit', () => {
  it('equal strings return true', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('different-length strings return false', () => {
    expect(timingSafeEqual('a', 'ab')).toBe(false);
    expect(timingSafeEqual('ab', 'a')).toBe(false);
  });

  it('different content of same length returns false', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('xyz', 'abc')).toBe(false);
  });

  it('prefix-only match returns false', () => {
    expect(timingSafeEqual('correct-prefix-then-wrong', 'correct-prefix-then-other')).toBe(false);
  });
});

describe('KNOWN_ROLES — explicit allow-list', () => {
  it('contains the five canonical roles', () => {
    expect(KNOWN_ROLES.has('founder')).toBe(true);
    expect(KNOWN_ROLES.has('compliance_officer')).toBe(true);
    expect(KNOWN_ROLES.has('owner')).toBe(true);
    expect(KNOWN_ROLES.has('analyst')).toBe(true);
    expect(KNOWN_ROLES.has('viewer')).toBe(true);
  });

  it('rejects made-up roles', () => {
    expect(KNOWN_ROLES.has('superuser')).toBe(false);
    expect(KNOWN_ROLES.has('root')).toBe(false);
    expect(KNOWN_ROLES.has('admin')).toBe(false);
    expect(KNOWN_ROLES.has('')).toBe(false);
  });
});

describe('resolveSecret — production hardening', () => {
  it('production with short secret THROWS', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_SECRET = 'short';
    expect(() => resolveSecret()).toThrow(/NEXTAUTH_SECRET must be set to a >=32-char value/);
  });

  it('production with no secret THROWS', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_SECRET;
    expect(() => resolveSecret()).toThrow();
  });

  it('production with adequate secret passes', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_SECRET = 'a'.repeat(40);
    expect(resolveSecret()).toBe('a'.repeat(40));
  });

  it('non-production with no secret returns a known fallback', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NEXTAUTH_SECRET;
    expect(resolveSecret()).toBe('dev-secret-change-in-prod');
  });
});
