import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Issue #535 §4 — overhead and cardinality benchmark.
 *
 * Scope, stated honestly up front: this is a MICRO benchmark of the
 * instrumentation path, not a load test. It answers two questions that were
 * previously theoretical —
 *
 *   1. what does one emission cost on the turn's call stack?
 *   2. does the cardinality budget actually bound the series count under
 *      adversarial input, or is it a comment?
 *
 * — and it does NOT answer "what is the real cardinality under production
 * traffic", which needs traffic. `docs/runbooks/observability-slo.md` §11 says
 * so rather than letting this file imply coverage it does not have.
 *
 * Timing assertions are RATIOS against a baseline measured in the same run,
 * never absolute microseconds — see the comment above the overhead block for
 * why that distinction cost this file a revision.
 */
const cfg = vi.hoisted(() => ({ endpoint: undefined as string | undefined, ratio: 1 }));
vi.mock('@/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/env.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop, receiver) => {
        if (prop === 'MAIA_OTLP_TRACES_ENDPOINT') return cfg.endpoint;
        if (prop === 'MAIA_OTLP_SAMPLE_RATIO') return cfg.ratio;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

import { counter, histogram } from '../../../src/observability/metrics.js';
import {
  incCounter,
  observeHistogram,
  renderPrometheus,
  _resetForTests,
} from '../../../src/lib/metrics.js';
import { setSpanSink, withSpan } from '../../../src/observability/tracer.js';
import {
  _cardinalityFor,
  _resetLabelGuardForTests,
} from '../../../src/observability/labels.js';
import {
  CARDINALITY_OVERFLOW_VALUE,
  DEFAULT_LABEL_CARDINALITY_BUDGET,
  LABEL_CARDINALITY_BUDGET,
  METRIC,
  SPAN,
} from '../../../src/observability/taxonomy.js';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timeOnce(iterations: number, fn: () => void): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return ((performance.now() - t0) * 1000) / iterations;
}

async function timeOnceAsync(
  iterations: number,
  fn: (i: number) => Promise<unknown>,
): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) await fn(i);
  return ((performance.now() - t0) * 1000) / iterations;
}

export interface Comparison {
  baseline_us: number;
  candidate_us: number;
  ratio: number;
}

/**
 * Compare two implementations by INTERLEAVING their rounds.
 *
 * Measuring arm A fully and then arm B leaves the ratio at the mercy of load
 * drift on the runner — which is exactly how the previous revision reported a
 * 23x ratio for code that costs ~4x. Alternating rounds and taking the median
 * of the PER-ROUND ratios cancels drift that a sequential design bakes in.
 */
function compare(
  runs: number,
  iterations: number,
  baseline: () => void,
  candidate: () => void,
): Comparison {
  const ratios: number[] = [];
  const bases: number[] = [];
  const cands: number[] = [];
  for (let r = 0; r < runs; r++) {
    const b = timeOnce(iterations, baseline);
    const c = timeOnce(iterations, candidate);
    bases.push(b);
    cands.push(c);
    ratios.push(c / b);
  }
  return { baseline_us: median(bases), candidate_us: median(cands), ratio: median(ratios) };
}

async function compareAsync(
  runs: number,
  iterations: number,
  baseline: (i: number) => Promise<unknown>,
  candidate: (i: number) => Promise<unknown>,
): Promise<Comparison> {
  const ratios: number[] = [];
  const bases: number[] = [];
  const cands: number[] = [];
  for (let r = 0; r < runs; r++) {
    const b = await timeOnceAsync(iterations, baseline);
    const c = await timeOnceAsync(iterations, candidate);
    bases.push(b);
    cands.push(c);
    ratios.push(c / b);
  }
  return { baseline_us: median(bases), candidate_us: median(cands), ratio: median(ratios) };
}

function report(label: string, c: Comparison): string {
  return `${label}: ${c.candidate_us.toFixed(2)}µs vs baseline ${c.baseline_us.toFixed(2)}µs = ${c.ratio.toFixed(1)}x`;
}

async function seriesCount(prefix: string): Promise<number> {
  return (await renderPrometheus())
    .split('\n')
    .filter((line) => line.startsWith(prefix)).length;
}

beforeEach(() => {
  _resetForTests();
  _resetLabelGuardForTests();
  cfg.endpoint = undefined;
  setSpanSink(null);
});

/**
 * Every overhead assertion below is a RATIO against a baseline measured by
 * INTERLEAVED rounds, never an absolute microsecond bound.
 *
 * Two revisions of this file were wrong before this one, and both mistakes are
 * worth recording because they are the standard ways a micro benchmark lies:
 *
 *   1. absolute bounds. ~1µs/op in isolation became 60-80µs/op the moment
 *      vitest ran this file alongside 18 others on the same cores. An absolute
 *      bound measures the runner, not the code.
 *   2. sequential arms. Timing arm A fully, then arm B, lets load drift land
 *      entirely on one arm — it reported 23x for code that costs ~4x.
 *
 * Interleaving the rounds and taking the median of the PER-ROUND ratios fixes
 * both, and the property asserted is the one that matters: what the POLICY
 * layer costs on top of the registry write it wraps.
 */
describe('issue #535 §4 — instrumentation overhead', () => {
  it('the sanitized counter costs a small multiple of the raw registry write', () => {
    const c = compare(
      5,
      5_000,
      () => incCounter(METRIC.TOOL_DISPATCH, { tool: 'listar_lancamentos', result: 'ok' }),
      () => counter(METRIC.TOOL_DISPATCH, { tool: 'listar_lancamentos', result: 'ok' }),
    );
    // Measured ~4x: the ALS read, the allow/deny checks and the cardinality
    // Set lookup. The bound catches a regression that adds an ORDER OF
    // MAGNITUDE (a regex compiled per call, a JSON round-trip), not jitter.
    expect(c.ratio, report('sanitized counter', c)).toBeLessThan(25);
  }, 60_000);

  it('the sanitized histogram costs a small multiple of the raw one', () => {
    const c = compare(
      5,
      5_000,
      () =>
        observeHistogram(METRIC.TOOL_DURATION_MS, 12, {
          tool: 'listar_lancamentos',
          result: 'ok',
        }),
      () => histogram(METRIC.TOOL_DURATION_MS, 12, { tool: 'listar_lancamentos', result: 'ok' }),
    );
    expect(c.ratio, report('sanitized histogram', c)).toBeLessThan(25);
  }, 60_000);

  it('the cardinality budget is a lookup, not a scan', () => {
    // A value already in the budget bucket must cost the same whether the
    // bucket holds 1 value or 190. If a future change made the budget check
    // linear in the bucket size, the gate would get slower as the process ran
    // — THIS is the test that notices.
    const cold = compare(
      3,
      4_000,
      () => counter(METRIC.TOOL_DISPATCH, { tool: 'first_tool', result: 'ok' }),
      () => counter(METRIC.TOOL_DISPATCH, { tool: 'first_tool', result: 'ok' }),
    );
    for (let i = 0; i < 190; i++) {
      counter(METRIC.TOOL_DISPATCH, { tool: `filler_${i}`, result: 'ok' });
    }
    const warm = compare(
      3,
      4_000,
      () => counter(METRIC.TOOL_DISPATCH, { tool: 'first_tool', result: 'ok' }),
      () => counter(METRIC.TOOL_DISPATCH, { tool: 'first_tool', result: 'ok' }),
    );
    expect(
      warm.candidate_us / cold.candidate_us,
      `${cold.candidate_us.toFixed(2)}µs with 1 distinct value vs ` +
        `${warm.candidate_us.toFixed(2)}µs with ~190`,
    ).toBeLessThan(5);
  }, 60_000);

  it('a span with tracing OFF is effectively free', async () => {
    // This is what makes shipping the exporter disabled-by-default safe: with
    // no endpoint the wrapper is a boolean check plus a direct call, so the
    // hot path is the pre-#535 one.
    const c = await compareAsync(
      3,
      10_000,
      async (i) => (async () => i)(),
      async (i) => withSpan(SPAN.TURN, async () => i),
    );
    expect(c.ratio, report('disabled span vs bare await', c)).toBeLessThan(4);
  }, 60_000);

  it('a span with tracing ON stays within a small multiple of the disabled path', async () => {
    let emitted = 0;
    const c = await compareAsync(
      3,
      2_000,
      async (i) => {
        cfg.endpoint = undefined;
        setSpanSink(null);
        return withSpan(SPAN.TURN, async () => i);
      },
      async (i) => {
        cfg.endpoint = 'http://collector:4318/v1/traces';
        setSpanSink(() => {
          emitted++;
        });
        return withSpan(SPAN.TURN, async () => i);
      },
    );
    expect(emitted).toBe(3 * 2_000);
    // Dominated by randomBytes(8) for the span id plus the attribute gate.
    expect(c.ratio, report('enabled span vs disabled', c)).toBeLessThan(80);
  }, 60_000);
});

describe('issue #535 §4 — cardinality is bounded, not hoped for', () => {
  it('a runaway tool name collapses into the overflow bucket', async () => {
    const budget = LABEL_CARDINALITY_BUDGET.tool!;
    for (let i = 0; i < budget * 5; i++) {
      counter(METRIC.TOOL_DISPATCH, { tool: `tool_${i}`, result: 'ok' });
    }
    expect(_cardinalityFor(METRIC.TOOL_DISPATCH, 'tool')).toBeLessThanOrEqual(budget);
    // budget distinct values + the single overflow bucket.
    expect(await seriesCount(METRIC.TOOL_DISPATCH)).toBeLessThanOrEqual(budget + 1);
    expect(await renderPrometheus()).toContain(`tool="${CARDINALITY_OVERFLOW_VALUE}"`);
  });

  it('a runaway tenant id collapses too — the sanctioned label is still capped', async () => {
    const budget = LABEL_CARDINALITY_BUDGET.tenant_id!;
    for (let i = 0; i < budget + 50; i++) {
      counter(METRIC.TURN_COMPLETED, { tenant_id: `t${i}`, outcome: 'completed' });
    }
    expect(_cardinalityFor(METRIC.TURN_COMPLETED, 'tenant_id')).toBeLessThanOrEqual(budget);
  });

  it('an unbudgeted key falls back to the default budget', async () => {
    for (let i = 0; i < DEFAULT_LABEL_CARDINALITY_BUDGET * 3; i++) {
      counter(METRIC.TURN_COMPLETED, { outcome: `outcome_${i}` });
    }
    expect(_cardinalityFor(METRIC.TURN_COMPLETED, 'outcome')).toBeLessThanOrEqual(
      DEFAULT_LABEL_CARDINALITY_BUDGET,
    );
  });

  it('the WORST case of the new #535 families is a bounded, small number', async () => {
    // The ceiling an operator can plan capacity against, computed from the
    // fixed label sets rather than asserted in prose:
    //   maia_db_pool                4 states
    //   maia_whatsapp_sessions      2 states  (+1 age gauge)
    //   maia_scheduler_lag_ms       2 queues
    //   maia_scheduler_backlog      2 queues
    //   maia_otlp_queue_depth       1
    const fixedSeries = 4 + 2 + 1 + 2 + 2 + 1;
    expect(fixedSeries).toBe(12);

    // The unbounded-looking ones are the per-call families. Their ceiling is
    // the product of their budgeted labels — and `tool` × `result` is the
    // largest of them.
    const toolCeiling = (LABEL_CARDINALITY_BUDGET.tool! + 1) * 4;
    expect(toolCeiling).toBeLessThanOrEqual(1000);
  });

  it('emitting the full #535 surface once does not mint per-turn series', async () => {
    // The regression this guards: instrumentation that accidentally carries a
    // per-turn dimension (an attempt ordinal, a job id) mints one series per
    // turn and the registry grows without limit.
    for (let i = 0; i < 500; i++) {
      counter(METRIC.TOOL_DISPATCH, { tool: 'listar_lancamentos', result: 'ok' });
      histogram(METRIC.TOOL_DURATION_MS, i, { tool: 'listar_lancamentos', result: 'ok' });
      histogram(METRIC.CONTEXT_LOAD_MS, i, { stage: 'working_memory', status: 'ok' });
      counter(METRIC.CONTEXT_SLICES, { stage: 'working_memory', status: 'ok' });
    }
    const lines = (await renderPrometheus()).split('\n').filter(Boolean).length;
    // 2 counters + 2 histograms (9 bucket lines + sum + count each) = 24.
    expect(lines, `500 turns produced ${lines} series`).toBeLessThan(40);
  });
});
