import { describe, it, expect, beforeEach } from 'vitest';
import {
  signHmac,
  verifyHmac,
  canonicalJson,
  deriveTenantKey,
  _resetHmacCacheForTests,
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
