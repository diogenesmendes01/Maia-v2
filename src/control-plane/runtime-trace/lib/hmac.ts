/**
 * P10b — Tenant-scoped HMAC-SHA256 signer (CRITICAL invariant 8).
 *
 * Each tenant gets a derived secret. We use HKDF-SHA256 with:
 *   - IKM    = RUNTIME_TRACE_HMAC_MASTER_SECRET (KMS material; env in tests)
 *   - salt   = `runtime-trace/v${HMAC_KEY_VERSION}`
 *   - info   = `tenant:${tenant_id}/v${HMAC_KEY_VERSION}`
 *
 * This prevents cross-tenant dictionary attacks: even with full visibility
 * into another tenant's HMACs, an attacker can't recover the secret or
 * forge a signature for their target tenant.
 *
 * Key rotation (90 days):
 *   - Operators bump RUNTIME_TRACE_HMAC_KEY_VERSION and supply a new master.
 *   - Old envelopes/bodies keep their `hmac_key_version` column for verify.
 *   - The cache is keyed by `(tenant_id, version)` so multiple versions coexist.
 *
 * Canonical JSON: we sort object keys recursively and JSON.stringify with
 * `null`/`undefined` skipped. This guarantees identical bytes regardless of
 * insertion order, so a re-signed payload always produces the same HMAC.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { config } from '@/config/env.js';

const KEY_CACHE = new Map<string, Buffer>();

function cacheKey(tenant_id: string, version: number): string {
  return `${tenant_id}::v${version}`;
}

/**
 * Test-only injection slot. NEVER read in prod paths — gated below by
 * NODE_ENV check. Tests call `_setTestMasterSecret(...)` from spec setup
 * to provide deterministic material WITHOUT silently weakening
 * production behaviour (Codex review #102 — issue 2).
 */
let __TEST_MASTER_SECRET: string | null = null;

/**
 * Test helper: install a deterministic master secret. Must NOT be called
 * outside `vitest`/`jest`. Asserts NODE_ENV at call time so accidental
 * production use throws immediately.
 */
export function _setTestMasterSecretForTests(secret: string): void {
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'p10b: _setTestMasterSecretForTests is forbidden when NODE_ENV=production',
    );
  }
  __TEST_MASTER_SECRET = secret;
  // Bust cache so the new secret takes effect immediately.
  KEY_CACHE.clear();
}

export function _clearTestMasterSecretForTests(): void {
  __TEST_MASTER_SECRET = null;
  KEY_CACHE.clear();
}

/**
 * Resolve the HMAC master secret.
 *
 * Codex review #102 — issue 2 (no-ship):
 *   Previously this returned a hardcoded literal when the env var was
 *   absent, which silently produced forgeable HMACs in a misconfigured
 *   production deploy. We now FAIL CLOSED: if FEATURE_RUNTIME_TRACE_V1
 *   is on and no master secret is present (env or test injection), throw
 *   on first call. The trace path is fail-closed (invariant 12), so
 *   throwing here aborts the side effect — better than silently writing
 *   audit rows an attacker could forge.
 */
function masterSecret(): Buffer {
  if (__TEST_MASTER_SECRET !== null) {
    return Buffer.from(__TEST_MASTER_SECRET, 'utf8');
  }
  const s = config.RUNTIME_TRACE_HMAC_MASTER_SECRET;
  if (!s) {
    throw new Error(
      'p10b: RUNTIME_TRACE_HMAC_MASTER_SECRET is required when FEATURE_RUNTIME_TRACE_V1 is enabled — ' +
        'audit HMACs would be forgeable without it. Configure via KMS-backed env or call ' +
        '_setTestMasterSecretForTests() in test setup.',
    );
  }
  return Buffer.from(s, 'utf8');
}

/**
 * Derive a tenant-scoped HMAC key. Cached. Synchronous because hkdfSync is
 * pure CPU; the trace envelope hot path can't afford an async hop.
 */
export function deriveTenantKey(tenant_id: string, version: number): Buffer {
  const k = cacheKey(tenant_id, version);
  const hit = KEY_CACHE.get(k);
  if (hit) return hit;
  const salt = Buffer.from(`runtime-trace/v${version}`, 'utf8');
  const info = Buffer.from(`tenant:${tenant_id}/v${version}`, 'utf8');
  // 32 bytes = SHA256 output length.
  const derived = Buffer.from(hkdfSync('sha256', masterSecret(), salt, info, 32));
  KEY_CACHE.set(k, derived);
  return derived;
}

/** Test-only: clear cache so spec can rotate keys without process restart. */
export function _resetHmacCacheForTests(): void {
  KEY_CACHE.clear();
}

/**
 * Canonical JSON encode: stable key ordering, no undefined props.
 * For trace payloads (objects, arrays, primitives only — no circular refs).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (obj[k] === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalJson(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  // Functions/symbols/bigint — defensively coerce to null.
  return 'null';
}

/** Sign a payload with the tenant-scoped key. Returns base64. */
export function signHmac(
  tenant_id: string,
  version: number,
  payload: unknown,
): string {
  const key = deriveTenantKey(tenant_id, version);
  const h = createHmac('sha256', key);
  h.update(canonicalJson(payload), 'utf8');
  return h.digest('base64');
}

/** Verify an HMAC. Constant-time compare. */
export function verifyHmac(
  tenant_id: string,
  version: number,
  payload: unknown,
  hmac: string,
): boolean {
  const expected = signHmac(tenant_id, version, payload);
  // base64 lengths must match before timingSafeEqual.
  if (expected.length !== hmac.length) return false;
  // Cheap constant-time compare on base64 strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  return diff === 0;
}

/** Currently-active version (from config). */
export function currentKeyVersion(): number {
  return config.RUNTIME_TRACE_HMAC_KEY_VERSION;
}
