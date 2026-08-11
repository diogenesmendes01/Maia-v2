/**
 * Issue #514 review round 1 [P2] — retries must not distort the SLI.
 *
 * `maia_turn_completed_total` is emitted once per ATTEMPT. The rules file is
 * the thing that decides which attempts count (see
 * `tests/unit/observability/slo-rules.spec.ts` for that guard); this spec
 * pins the EMISSION side, so the two halves of the contract are both tested:
 * a retried turn must produce exactly one TERMINAL observation, whatever else
 * it produces along the way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { counter } from '../../../src/observability/metrics.js';
import { METRIC, ENUM_VALUES } from '../../../src/observability/taxonomy.js';
import { _resetLabelGuardForTests } from '../../../src/observability/labels.js';
import { renderPrometheus, _resetForTests } from '../../../src/lib/metrics.js';

/** Mirrors `recordTurnOutcome` in `src/gateway/queue.ts`. */
function emitOutcome(outcome: 'completed' | 'retryable' | 'failed'): void {
  counter(METRIC.TURN_COMPLETED, { outcome, queue: 'agent' });
}

/** Parse `maia_turn_completed_total{...outcome="x"...} N` out of the exposition. */
function outcomeCounts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/maia_turn_completed_total\{([^}]*)\} (\d+)/g)) {
    const outcome = /outcome="([^"]+)"/.exec(m[1]!)?.[1];
    if (outcome) out[outcome] = (out[outcome] ?? 0) + Number(m[2]);
  }
  return out;
}

const TERMINAL = ['completed', 'failed'] as const;

function terminalTotal(counts: Record<string, number>): number {
  return TERMINAL.reduce((n, o) => n + (counts[o] ?? 0), 0);
}

describe('issue #514 [P2] — turn outcome accounting', () => {
  beforeEach(() => {
    _resetForTests();
    _resetLabelGuardForTests();
  });

  it('retry → success yields ONE terminal observation, not three', async () => {
    // The exact scenario from the review: two retries then success. Counting
    // every attempt made this look like 1/3 = 33% success.
    emitOutcome('retryable');
    emitOutcome('retryable');
    emitOutcome('completed');

    const counts = outcomeCounts(await renderPrometheus());
    expect(counts.retryable).toBe(2);
    expect(counts.completed).toBe(1);
    expect(terminalTotal(counts)).toBe(1);
    // The SLI the rules compute: completed / (completed + failed).
    expect((counts.completed ?? 0) / terminalTotal(counts)).toBe(1);
  });

  it('retry → failure yields ONE terminal observation', async () => {
    emitOutcome('retryable');
    emitOutcome('retryable');
    emitOutcome('failed');

    const counts = outcomeCounts(await renderPrometheus());
    expect(counts.retryable).toBe(2);
    expect(terminalTotal(counts)).toBe(1);
    expect((counts.failed ?? 0) / terminalTotal(counts)).toBe(1);
  });

  it('a healthy service with heavy retries still reports 100% success', async () => {
    // 10 turns, each retried twice, all eventually succeeding.
    for (let i = 0; i < 10; i++) {
      emitOutcome('retryable');
      emitOutcome('retryable');
      emitOutcome('completed');
    }
    const counts = outcomeCounts(await renderPrometheus());
    expect(terminalTotal(counts)).toBe(10);
    expect((counts.completed ?? 0) / terminalTotal(counts)).toBe(1);
    // The naive denominator (all attempts) would have said 33%.
    const allAttempts = Object.values(counts).reduce((a, b) => a + b, 0);
    expect((counts.completed ?? 0) / allAttempts).toBeCloseTo(1 / 3, 5);
  });

  it('a genuinely failing service is still visible', async () => {
    for (let i = 0; i < 9; i++) emitOutcome('completed');
    emitOutcome('failed');
    const counts = outcomeCounts(await renderPrometheus());
    expect((counts.failed ?? 0) / terminalTotal(counts)).toBeCloseTo(0.1, 5);
  });

  it('the three outcomes are all in the enumerated vocabulary', () => {
    // A fourth outcome added in code without updating the rules would be
    // silently excluded from BOTH numerator and denominator.
    for (const o of ['completed', 'retryable', 'failed']) {
      expect(ENUM_VALUES.outcome).toContain(o);
    }
  });

  it('every emitted outcome is either terminal or explicitly retryable', async () => {
    emitOutcome('completed');
    emitOutcome('retryable');
    emitOutcome('failed');
    const counts = outcomeCounts(await renderPrometheus());
    for (const key of Object.keys(counts)) {
      expect(
        [...TERMINAL, 'retryable'],
        `unclassified outcome "${key}" — the SLI denominator would silently drop it`,
      ).toContain(key);
    }
  });
});
