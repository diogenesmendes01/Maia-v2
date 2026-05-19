/**
 * P8b — Origin gate exhaustive tests (4 origins × strength matrix).
 *
 * canSoulOverrideIdentity é uma pure function — sem mocks, sem IO.
 * Cobertura: cada origin, cada lado dos thresholds, cenários edge.
 */
import { describe, it, expect } from 'vitest';
import {
  canSoulOverrideIdentity,
  ORIGIN_GATE_STRENGTH_THRESHOLD,
} from '@/control-plane/soul/origin-gate.js';

describe('originGate (P8b §7)', () => {
  describe('strength >= threshold (0.95) + trusted origin → ALLOWED', () => {
    it('founder_explicit + strength=0.95 permite override', () => {
      const r = canSoulOverrideIdentity({ origin: 'founder_explicit', strength: 0.95 });
      expect(r.allowed).toBe(true);
      if (r.allowed) expect(r.reason).toBe('origin_trusted_and_strong');
    });

    it('founder_explicit + strength=1.0 permite override', () => {
      const r = canSoulOverrideIdentity({ origin: 'founder_explicit', strength: 1.0 });
      expect(r.allowed).toBe(true);
    });

    it('human_approved + strength=0.97 permite override', () => {
      const r = canSoulOverrideIdentity({ origin: 'human_approved', strength: 0.97 });
      expect(r.allowed).toBe(true);
    });

    it('tenant_culture_explicit + strength=0.95 permite override', () => {
      const r = canSoulOverrideIdentity({
        origin: 'tenant_culture_explicit',
        strength: 0.95,
      });
      expect(r.allowed).toBe(true);
    });
  });

  describe('learned_strong_evidence — SEMPRE bloqueia (qualquer strength)', () => {
    it('strength=1.0 bloqueado, emite soul_identity_conflict alert', () => {
      const r = canSoulOverrideIdentity({
        origin: 'learned_strong_evidence',
        strength: 1.0,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) {
        expect(r.reason).toBe('origin_blocks_override');
        if (r.reason === 'origin_blocks_override') {
          expect(r.alert).toBe('soul_identity_conflict');
        }
      }
    });

    it('strength=0.95 (no threshold) ainda bloqueia learned_strong_evidence', () => {
      const r = canSoulOverrideIdentity({
        origin: 'learned_strong_evidence',
        strength: 0.95,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed && r.reason === 'origin_blocks_override') {
        expect(r.alert).toBe('soul_identity_conflict');
      }
    });

    it('strength=0.99 bloqueia learned_strong_evidence', () => {
      const r = canSoulOverrideIdentity({
        origin: 'learned_strong_evidence',
        strength: 0.99,
      });
      expect(r.allowed).toBe(false);
    });
  });

  describe('strength < threshold → BLOQUEIO (qualquer origin)', () => {
    const origins: Array<
      | 'founder_explicit'
      | 'human_approved'
      | 'tenant_culture_explicit'
      | 'learned_strong_evidence'
    > = [
      'founder_explicit',
      'human_approved',
      'tenant_culture_explicit',
      'learned_strong_evidence',
    ];
    for (const origin of origins) {
      it(`${origin} + strength=0.94 (< 0.95) bloqueia com strength_below_threshold`, () => {
        const r = canSoulOverrideIdentity({ origin, strength: 0.94 });
        expect(r.allowed).toBe(false);
        if (!r.allowed) expect(r.reason).toBe('strength_below_threshold');
      });

      it(`${origin} + strength=0.5 bloqueia`, () => {
        const r = canSoulOverrideIdentity({ origin, strength: 0.5 });
        expect(r.allowed).toBe(false);
      });

      it(`${origin} + strength=0.0 bloqueia`, () => {
        const r = canSoulOverrideIdentity({ origin, strength: 0.0 });
        expect(r.allowed).toBe(false);
      });
    }
  });

  describe('constantes exportadas', () => {
    it('ORIGIN_GATE_STRENGTH_THRESHOLD é 0.95', () => {
      expect(ORIGIN_GATE_STRENGTH_THRESHOLD).toBe(0.95);
    });
  });

  describe('threshold boundary é INCLUSIVE em 0.95', () => {
    it('exatamente 0.95 permite (founder_explicit)', () => {
      const r = canSoulOverrideIdentity({ origin: 'founder_explicit', strength: 0.95 });
      expect(r.allowed).toBe(true);
    });

    it('apenas 0.0001 abaixo (0.9499) bloqueia', () => {
      const r = canSoulOverrideIdentity({ origin: 'founder_explicit', strength: 0.9499 });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toBe('strength_below_threshold');
    });
  });
});
