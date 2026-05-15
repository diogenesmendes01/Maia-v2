import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeP95, assertWithinBudget } from '@/cognitive-graph/latency-budget.js';

describe('P7 — latency budget helpers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computeP95 retorna percentil 95 correto de array', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(computeP95(values)).toBe(95);
  });

  it('computeP95 retorna 0 em array vazio (no-data safe)', () => {
    expect(computeP95([])).toBe(0);
  });

  it('assertWithinBudget aceita baseline undefined → skip ok=true', () => {
    expect(assertWithinBudget({ observed_p95_ms: 5000, baseline_p95_ms: undefined, budget_percent: 20 })).toEqual({ ok: true, skipped: true, budget_ms: undefined });
  });

  it('assertWithinBudget calcula budget = baseline * (1 + percent/100)', () => {
    expect(assertWithinBudget({ observed_p95_ms: 1100, baseline_p95_ms: 1000, budget_percent: 20 }))
      .toEqual({ ok: true, skipped: false, budget_ms: 1200 });
    expect(assertWithinBudget({ observed_p95_ms: 1300, baseline_p95_ms: 1000, budget_percent: 20 }))
      .toEqual({ ok: false, skipped: false, budget_ms: 1200 });
  });
});
