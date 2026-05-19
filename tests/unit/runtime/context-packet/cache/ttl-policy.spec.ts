/**
 * P8a Task 12 — TTL policy unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  getTTLForSlice,
  jitteredTTL,
  TTL_BOUNDS,
} from '@/runtime/context-packet/cache/ttl-policy.js';

describe('TTL policy', () => {
  it('returns positive TTLs for every slice', () => {
    for (const slice of [
      'identity',
      'user',
      'knowledge',
      'soul',
      'policy',
      'skill',
      'tool',
      'history',
    ] as const) {
      const ttl = getTTLForSlice(slice);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(TTL_BOUNDS.MAX_TTL);
    }
  });

  it('identity / soul / policy get long TTLs (>= 300s)', () => {
    expect(getTTLForSlice('identity')).toBeGreaterThanOrEqual(300);
    expect(getTTLForSlice('soul')).toBeGreaterThanOrEqual(300);
    expect(getTTLForSlice('policy')).toBeGreaterThanOrEqual(300);
  });

  it('history gets a very short TTL (per-turn)', () => {
    expect(getTTLForSlice('history')).toBeLessThan(60);
  });

  it('jitteredTTL stays within ±10% bounds', () => {
    const base = 100;
    for (let i = 0; i < 50; i++) {
      const t = jitteredTTL(base);
      expect(t).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
      expect(t).toBeLessThanOrEqual(Math.floor(base * 1.1));
    }
  });

  it('jitteredTTL clamps to min/max bounds', () => {
    expect(jitteredTTL(1)).toBeGreaterThanOrEqual(TTL_BOUNDS.MIN_TTL);
    expect(jitteredTTL(1_000_000)).toBeLessThanOrEqual(TTL_BOUNDS.MAX_TTL);
  });

  it('jitteredTTL is deterministic when rand is injected', () => {
    expect(jitteredTTL(100, () => 0)).toBe(90);
    expect(jitteredTTL(100, () => 0.5)).toBe(100);
    expect(jitteredTTL(100, () => 0.999)).toBe(109);
  });
});
