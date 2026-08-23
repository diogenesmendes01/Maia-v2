/**
 * P10b — Tenant-scoped HMAC-SHA256 signer (CRITICAL invariant 8).
 *
 * Each tenant gets a derived secret. We use HKDF-SHA256 with:
 *   - IKM    = master secret for `hmac_key_version` (from versioned keyring)
 *   - salt   = `runtime-trace/v${HMAC_KEY_VERSION}`
 *   - info   = `tenant:${tenant_id}/v${HMAC_KEY_VERSION}`
 *
 * This prevents cross-tenant dictionary attacks: even with full visibility
 * into another tenant's HMACs, an attacker can't recover the secret or
 * forge a signature for their target tenant.
 *
 * Key rotation (90 days) — round-2 finding #3 fix:
 *   - Operators bump RUNTIME_TRACE_HMAC_KEY_VERSION and supply a new master.
 *   - The OLD master is retained in RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS
 *     (format: "1=<secret>;2=<secret>") through the audit-retention window.
 *   - `deriveTenantKey(tenant_id, version)` resolves the correct master for
 *     the requested version — current OR previous — so old audit rows remain
 *     verifiable after rotation.
 *   - The cache is keyed by `(tenant_id, version)` so multiple versions coexist.
 *
 * Canonical JSON: we sort object keys recursively and JSON.stringify with
 * `null`/`undefined` skipped. This guarantees identical bytes regardless of
 * insertion order, so a re-signed payload always produces the same HMAC.
 */
import { createHmac, hkdfSync } from 'node:crypto';
// Módulo COMPARTILHADO por mais de um container (runtime e admin-ui): lê o
// contrato sob demanda em vez de arrastar o boot do subset `runtime` para
// dentro do console. Ver src/config/contract-env.ts (issue #596).
import { contractEnv as config } from '@/config/contract-env.js';

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
 * Test-only versioned keyring. Keys are `version` → `secret_string`.
 * This mirrors the prod RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS env var
 * without coupling tests to env parsing.
 */
const __TEST_KEYRING = new Map<number, string>();

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

/**
 * Test helper: register a previous-version master secret.
 * Simulates rotating from version `version` to a new current master.
 *
 * Usage in tests:
 *   _setTestMasterSecretForTests('new-master');          // current (new)
 *   _setTestKeyringEntryForTests(1, 'old-master');       // previous v1
 */
export function _setTestKeyringEntryForTests(version: number, secret: string): void {
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'p10b: _setTestKeyringEntryForTests is forbidden when NODE_ENV=production',
    );
  }
  __TEST_KEYRING.set(version, secret);
  KEY_CACHE.clear();
}

export function _clearTestMasterSecretForTests(): void {
  __TEST_MASTER_SECRET = null;
  __TEST_KEYRING.clear();
  KEY_CACHE.clear();
}

/**
 * Parse the RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS env var into a Map.
 * Format: "1=<secret>;2=<secret>" — semicolon-separated version=secret pairs.
 * Invalid entries are skipped with a warning (fail-safe: current master still works).
 */
function parsePrevSecrets(raw: string | undefined): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const vStr = pair.slice(0, idx).trim();
    const sStr = pair.slice(idx + 1).trim();
    const v = parseInt(vStr, 10);
    if (isNaN(v) || v < 1 || !sStr) continue;
    out.set(v, Buffer.from(sStr, 'utf8'));
  }
  return out;
}

/** Lazily-parsed previous keyring from env (not reparsed on every call). */
let _prevSecretsCache: Map<number, Buffer> | null = null;
function prevSecrets(): Map<number, Buffer> {
  if (_prevSecretsCache === null) {
    _prevSecretsCache = parsePrevSecrets(config.RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS);
  }
  return _prevSecretsCache;
}

/**
 * Resolve the HMAC master secret for a given key version.
 *
 * Version lookup order:
 *   1. Test-injected keyring (test env only).
 *   2. If `version` == current configured version: current master secret.
 *   3. Previous secrets registry (RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS).
 *   4. Throw — version unknown and unverifiable.
 *
 * Codex review #102 — issue 2 (no-ship):
 *   FAIL CLOSED: no fallback to a hardcoded literal. Missing config throws.
 *
 * Codex review round-2 — finding #3 (no-ship):
 *   `deriveTenantKey()` previously always used the CURRENT master secret
 *   regardless of the requested version. After rotation, verifying an old
 *   row with version=1 would derive v1 from the NEW master — producing a
 *   different key than the original signer used → verification fails.
 *   Fix: version-keyed lookup resolves the ORIGINAL master for each version.
 */
function masterSecretForVersion(version: number): Buffer {
  const currentVersion = config.RUNTIME_TRACE_HMAC_KEY_VERSION;

  // 1. Test keyring (version-specific overrides).
  if (config.NODE_ENV !== 'production' && __TEST_KEYRING.has(version)) {
    return Buffer.from(__TEST_KEYRING.get(version)!, 'utf8');
  }

  // 2. Current version → current master.
  if (version === currentVersion) {
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

  // 3. Previous keyring from env.
  const prev = prevSecrets().get(version);
  if (prev) return prev;

  // 4. Fail closed — we cannot verify rows signed with an unknown version.
  throw new Error(
    `p10b: HMAC master secret for version ${version} not found in keyring. ` +
      `Current version is ${currentVersion}. ` +
      `Add previous master secrets to RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS ` +
      `as "${version}=<secret>" to keep old audit rows verifiable through the retention window.`,
  );
}

/**
 * The versioned keyring, exposed for OTHER holders of long-lived evidence
 * signed with this same master material (issue #536, round-2 review of PR
 * #541: `src/ops/backup/manifest-keyring.ts`).
 *
 * Additive only — `masterSecretForVersion` is unchanged and `deriveTenantKey`
 * still calls it directly, so runtime-trace behaviour (including the fail-
 * closed throw for an unknown version) is byte-for-byte what it was. Exporting
 * the resolver rather than copying the env parsing is the point: two parsers
 * for `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS` would drift, and a drifted
 * keyring is an unrestorable backup.
 *
 * Throws for a version this deployment does not hold — callers that need a
 * verdict rather than an exception wrap it.
 */
export function hmacMasterSecretForVersion(version: number): Buffer {
  return masterSecretForVersion(version);
}

/**
 * Derive a tenant-scoped HMAC key. Cached. Synchronous because hkdfSync is
 * pure CPU; the trace envelope hot path can't afford an async hop.
 *
 * Round-2 fix: resolves master secret by `version`, not always by current
 * version, so old rows remain verifiable after key rotation.
 */
export function deriveTenantKey(tenant_id: string, version: number): Buffer {
  const k = cacheKey(tenant_id, version);
  const hit = KEY_CACHE.get(k);
  if (hit) return hit;
  const salt = Buffer.from(`runtime-trace/v${version}`, 'utf8');
  const info = Buffer.from(`tenant:${tenant_id}/v${version}`, 'utf8');
  // 32 bytes = SHA256 output length.
  const derived = Buffer.from(hkdfSync('sha256', masterSecretForVersion(version), salt, info, 32));
  KEY_CACHE.set(k, derived);
  return derived;
}

/** Test-only: clear cache so spec can rotate keys without process restart. */
export function _resetHmacCacheForTests(): void {
  KEY_CACHE.clear();
  // Also clear the prev-secrets parse cache so tests that mutate env see updates.
  _prevSecretsCache = null;
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
