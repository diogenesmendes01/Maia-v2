import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Codex review #102 issue 2: HMAC fails closed when no master secret is
// configured. Tests install a deterministic secret via the injection slot
// instead of relying on the (now-removed) silent fallback.
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_HMAC_MASTER_SECRET: undefined,
  },
}));

import {
  signHmac,
  verifyHmac,
  canonicalJson,
  deriveTenantKey,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
  _clearTestMasterSecretForTests,
} from '../../src/control-plane/runtime-trace/lib/hmac.js';

/**
 * P10b — HMAC + canonical JSON tests (CRITICAL invariant 8).
 *
 * Invariant: HMAC is tenant-scoped so an attacker who fully owns tenant A
 * cannot forge a valid HMAC for tenant B's envelope.
 */
describe('runtime-trace HMAC', () => {
  beforeEach(() => {
    _resetHmacCacheForTests();
    _setTestMasterSecretForTests('p10b-unit-test-master-secret-deterministic');
  });

  afterAll(() => {
    _clearTestMasterSecretForTests();
  });

  describe('canonicalJson', () => {
    it('produces stable bytes regardless of insertion order', () => {
      const a = canonicalJson({ b: 1, a: 2, c: 3 });
      const b = canonicalJson({ c: 3, a: 2, b: 1 });
      expect(a).toBe(b);
      expect(a).toBe('{"a":2,"b":1,"c":3}');
    });

    it('handles nested objects with sorted keys', () => {
      const out = canonicalJson({ z: { y: 1, x: 2 }, a: [3, 2, 1] });
      expect(out).toBe('{"a":[3,2,1],"z":{"x":2,"y":1}}');
    });

    it('skips undefined fields but encodes nulls', () => {
      const out = canonicalJson({ a: undefined, b: null, c: 1 });
      expect(out).toBe('{"b":null,"c":1}');
    });

    it('top-level null returns the literal string', () => {
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(undefined)).toBe('null');
    });

    it('serializes primitives consistently', () => {
      expect(canonicalJson(true)).toBe('true');
      expect(canonicalJson(42)).toBe('42');
      expect(canonicalJson('hi')).toBe('"hi"');
    });
  });

  describe('signHmac / verifyHmac', () => {
    it('signed payload verifies', () => {
      const payload = { trace_id: 't1', decision: 'allow' };
      const sig = signHmac('tenant-a', 1, payload);
      expect(verifyHmac('tenant-a', 1, payload, sig)).toBe(true);
    });

    it('different tenants produce DIFFERENT HMACs for the same payload (tenant-scoped)', () => {
      const payload = { trace_id: 't1', decision: 'allow' };
      const sigA = signHmac('tenant-a', 1, payload);
      const sigB = signHmac('tenant-b', 1, payload);
      expect(sigA).not.toBe(sigB);
    });

    it('cross-tenant verify FAILS (invariant 8 — no cross-tenant dictionary attack)', () => {
      const payload = { trace_id: 't1', decision: 'allow' };
      const sigA = signHmac('tenant-a', 1, payload);
      // tenant-b cannot accept tenant-a's signature even with full knowledge.
      expect(verifyHmac('tenant-b', 1, payload, sigA)).toBe(false);
    });

    it('different key versions produce DIFFERENT HMACs (90d rotation)', () => {
      const payload = { trace_id: 't1' };
      const sigV1 = signHmac('tenant-a', 1, payload);
      const sigV2 = signHmac('tenant-a', 2, payload);
      expect(sigV1).not.toBe(sigV2);
      // Old envelope verified against new version → false.
      expect(verifyHmac('tenant-a', 2, payload, sigV1)).toBe(false);
    });

    it('tampered payload fails verify', () => {
      const payload = { trace_id: 't1', decision: 'allow' };
      const sig = signHmac('tenant-a', 1, payload);
      const tampered = { trace_id: 't1', decision: 'deny' };
      expect(verifyHmac('tenant-a', 1, tampered, sig)).toBe(false);
    });

    it('key-order-different but equivalent payload still verifies (canonical encoding)', () => {
      const sig = signHmac('tenant-a', 1, { a: 1, b: 2 });
      expect(verifyHmac('tenant-a', 1, { b: 2, a: 1 }, sig)).toBe(true);
    });
  });

  describe('determinism property tests', () => {
    // Codex review #102: HMAC must be deterministic within a tenant so a
    // re-signed payload always matches verify(). We assert this across 50
    // random payloads × 3 tenants.
    function randomPayload(seed: number): Record<string, unknown> {
      const rng = (i: number) => ((seed * 9301 + 49297 * (i + 1)) % 233280) / 233280;
      const depth = 1 + Math.floor(rng(0) * 3);
      const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < depth + 2; i++) {
        const k = keys[Math.floor(rng(i + 1) * keys.length)]!;
        const which = Math.floor(rng(i + 7) * 4);
        if (which === 0) out[k] = Math.floor(rng(i + 11) * 1000);
        else if (which === 1) out[k] = rng(i + 13) > 0.5;
        else if (which === 2) out[k] = `s${i}-${Math.floor(rng(i + 17) * 100)}`;
        else out[k] = [rng(i) > 0.5, rng(i + 1) > 0.5];
      }
      return out;
    }

    it('signHmac is deterministic within a tenant (50 random payloads × 3 tenants)', () => {
      const tenants = ['tenant-alpha', 'tenant-beta', 'tenant-gamma'];
      for (let i = 0; i < 50; i++) {
        const payload = randomPayload(i);
        for (const t of tenants) {
          const sig1 = signHmac(t, 1, payload);
          const sig2 = signHmac(t, 1, payload);
          expect(sig1).toBe(sig2);
        }
      }
    });

    it('signHmac differs across tenants for every random payload (50 × 3 pairs)', () => {
      for (let i = 0; i < 50; i++) {
        const payload = randomPayload(i);
        const sigA = signHmac('tenant-alpha', 1, payload);
        const sigB = signHmac('tenant-beta', 1, payload);
        const sigC = signHmac('tenant-gamma', 1, payload);
        expect(sigA).not.toBe(sigB);
        expect(sigB).not.toBe(sigC);
        expect(sigA).not.toBe(sigC);
      }
    });
  });

  describe('fail-closed behaviour (Codex review #102)', () => {
    it('throws when no master secret configured (fail-closed in prod)', () => {
      _clearTestMasterSecretForTests();
      // No test secret AND no env var → must throw, not fall back.
      expect(() => signHmac('tenant-x', 1, { a: 1 })).toThrow(
        /RUNTIME_TRACE_HMAC_MASTER_SECRET is required/,
      );
      // Restore for any subsequent test.
      _setTestMasterSecretForTests('p10b-unit-test-master-secret-deterministic');
    });
  });

  describe('deriveTenantKey caching', () => {
    it('returns the same buffer instance for repeated calls', () => {
      const k1 = deriveTenantKey('tenant-a', 1);
      const k2 = deriveTenantKey('tenant-a', 1);
      expect(k1).toBe(k2);
    });

    it('returns a different key after reset', () => {
      const k1 = deriveTenantKey('tenant-a', 1);
      _resetHmacCacheForTests();
      const k2 = deriveTenantKey('tenant-a', 1);
      // Same bytes (deterministic from same material), but different instance.
      expect(k2.equals(k1)).toBe(true);
      expect(k2).not.toBe(k1);
    });
  });
});
