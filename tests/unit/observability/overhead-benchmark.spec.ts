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
 * Question 1 is answered on TWO axes, and the split is the point (issue #600):
 *
 *   - WORK, counted: how many times the instrumented path reaches for an
 *     expensive primitive per span (`randomBytes`, `createHash`, a JSON
 *     round-trip) and how many spans it emits. No clock is involved, so the
 *     answer is the same on an idle laptop and on a runner with four other
 *     jobs on the same cores, and the same on Node 22 and Node 26.
 *   - TIME, as a ratio against work of COMPARABLE magnitude measured in the
 *     same run — never against a sub-microsecond baseline, and never in
 *     absolute microseconds. See the comment above the overhead block.
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

/**
 * Issue #600 — the clock-free half of the measurement.
 *
 * `node:crypto` is wrapped (never replaced: every call is forwarded verbatim)
 * so the suite can COUNT the expensive primitives the span path reaches for,
 * instead of timing them. A counted call is a fact; a timed one is a fact
 * about the runner. Both `tracer.ts` and `correlation.ts` import from here, so
 * the count covers the whole instrumentation path, not one module's share.
 */
const work = vi.hoisted(() => ({
  randomBytes: 0,
  randomBytesBytes: 0,
  createHash: 0,
  randomUUID: 0,
  json: 0,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number, cb?: (err: Error | null, buf: Buffer) => void) => {
      work.randomBytes++;
      work.randomBytesBytes += size;
      return cb === undefined ? actual.randomBytes(size) : actual.randomBytes(size, cb);
    }) as typeof actual.randomBytes,
    createHash: ((...args: Parameters<typeof actual.createHash>) => {
      work.createHash++;
      return actual.createHash(...args);
    }) as typeof actual.createHash,
    randomUUID: ((...args: Parameters<typeof actual.randomUUID>) => {
      work.randomUUID++;
      return actual.randomUUID(...args);
    }) as typeof actual.randomUUID,
  };
});

import { counter, histogram } from '../../../src/observability/metrics.js';
import {
  incCounter,
  observeHistogram,
  renderPrometheus,
  _resetForTests,
} from '../../../src/lib/metrics.js';
import {
  currentSpan,
  newSpanId,
  setSpanSink,
  traceIdToW3C,
  withSpan,
} from '../../../src/observability/tracer.js';
import { sanitizeSpanAttributes } from '../../../src/observability/span-attributes.js';
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
  // WARMUP round, discarded: the first pass through either arm pays V8's
  // interpreter-to-optimized transition, and whichever arm pays it first
  // carries a penalty that has nothing to do with the code under test.
  timeOnce(iterations, baseline);
  timeOnce(iterations, candidate);
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
  // Same warmup round as `compare`, and for the same reason. It runs the arms
  // for real, so a caller that counts side effects has to add `WARMUP_ROUNDS`
  // to its arithmetic.
  await timeOnceAsync(iterations, baseline);
  await timeOnceAsync(iterations, candidate);
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

/** Rounds `compare`/`compareAsync` run and DISCARD before measuring. */
const WARMUP_ROUNDS = 1;

export interface WorkCount {
  randomBytes: number;
  randomBytesBytes: number;
  createHash: number;
  randomUUID: number;
  json: number;
}

/**
 * Run `fn` with the expensive primitives counted, and return the tally.
 *
 * `JSON` is patched here rather than in a `vi.mock` because it is a global,
 * not a module: the patch has to be narrow enough that it cannot outlive the
 * measured block (an expectation matcher serializes, and would be counted).
 */
async function countWork(fn: () => Promise<void>): Promise<WorkCount> {
  const realStringify = JSON.stringify;
  const realParse = JSON.parse;
  work.randomBytes = 0;
  work.randomBytesBytes = 0;
  work.createHash = 0;
  work.randomUUID = 0;
  work.json = 0;
  JSON.stringify = function (...args: unknown[]) {
    work.json++;
    return (realStringify as (...a: unknown[]) => string)(...args);
  } as typeof JSON.stringify;
  JSON.parse = function (...args: unknown[]) {
    work.json++;
    return (realParse as (...a: unknown[]) => unknown)(...args);
  } as typeof JSON.parse;
  try {
    await fn();
  } finally {
    JSON.stringify = realStringify;
    JSON.parse = realParse;
  }
  return {
    randomBytes: work.randomBytes,
    randomBytesBytes: work.randomBytesBytes,
    createHash: work.createHash,
    randomUUID: work.randomUUID,
    json: work.json,
  };
}

/**
 * Everything an enabled span MUST do, with the wrapper stripped away: mint the
 * two W3C ids and run the attribute set through the gate.
 *
 * This is the baseline the timed assertion compares against, and choosing it
 * is the whole fix for issue #600. The old baseline was a bare `await` at
 * ~0.4µs, so the assertion divided a ~35µs numerator by a denominator smaller
 * than the runner's scheduling jitter — a quantity that moved 80.2x → 86.5x
 * between two retries of the SAME commit, and that Node 26 broke outright by
 * making bare async frames cheaper without making crypto cheaper. This
 * baseline is ~15-20µs, the same order as the thing it is divided into, and it
 * is made of the SAME primitives, so a Node release that changes the cost of
 * `randomBytes` or of the gate moves numerator and denominator together.
 *
 * What the ratio then states is the property worth stating: the span wrapper
 * costs a small multiple of the work it exists to perform.
 */
function irreducibleSpanWork(): number {
  const trace = traceIdToW3C(undefined);
  const span = newSpanId();
  const { attributes } = sanitizeSpanAttributes(SPAN.TURN, {
    tenant_id: 'system',
    agent_id: 'system',
    status: 'ok',
  });
  return trace.length + span.length + Object.keys(attributes).length;
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
 * THREE revisions of this file were wrong before this one, and all three are
 * worth recording because they are the standard ways a micro benchmark lies:
 *
 *   1. absolute bounds. ~1µs/op in isolation became 60-80µs/op the moment
 *      vitest ran this file alongside 18 others on the same cores. An absolute
 *      bound measures the runner, not the code.
 *   2. sequential arms. Timing arm A fully, then arm B, lets load drift land
 *      entirely on one arm — it reported 23x for code that costs ~4x.
 *   3. a DEGENERATE denominator (issue #600). Fixing 1 and 2 with a ratio was
 *      right; picking a sub-microsecond baseline for it was not. `enabled span
 *      vs disabled` divided ~35µs by ~0.4µs, and a 0.4µs quantity on a shared
 *      runner is noise with a mean. The published symptom: the same commit
 *      reported 80.2x and 86.5x on two retries of PR #598 and failed both,
 *      passed on the Node 22.18 lane of that very run, and passed again on a
 *      re-run. Raising the ceiling would have kept the noise and thrown away
 *      the sensitivity, so the ceiling is not what changed.
 *
 * What changed: every span assertion below is now either COUNTED WORK (no
 * clock at all) or a ratio against a baseline of the SAME ORDER OF MAGNITUDE
 * built from the SAME primitives (`irreducibleSpanWork`). Reproduced locally
 * with six CPU burners pinning a 4-vCPU box, 12 runs on each Node lane:
 *
 *              Node 22.22        Node 26.7
 *   old file   3/12 red          5/12 red     (89.8x-152.3x, the #598 numbers)
 *   this file  0/12 red          0/12 red
 *
 * and this file still goes red 12/12 on each injected regression — a JSON
 * round-trip in `emit`, a digest per call, a regex recompiled per call.
 *
 * The two metric assertions keep the interleaved-ratio design of revision 2
 * unchanged: their baseline is a raw registry write of the same order as the
 * sanitized one, so they were never in the degenerate regime (0 failures in
 * the same 12 loaded runs).
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

  it('a span with tracing OFF does no work at all — not "a small multiple", zero', async () => {
    // This is what makes shipping the exporter disabled-by-default safe: with
    // no endpoint the wrapper is a boolean check plus a direct call, so the
    // hot path is the pre-#535 one.
    //
    // The previous revision asserted `< 4x` a bare `await`. A bare await costs
    // ~0.15µs, so that assertion was the #600 defect in miniature and it went
    // red twice in 12 loaded runs (7.4x, 9.0x) on code that had not changed.
    // The claim it was reaching for is not a multiple, it is a ZERO, and a
    // zero is countable: no id minted, no digest, no serialization, no
    // emission, and — the structural half — no `AsyncLocalStorage` frame
    // entered, which is what "no allocation" reduces to here since the span
    // object is created only inside `spanStorage.run`.
    //
    // The sink is INSTALLED and counting; only the endpoint is absent. That is
    // the shipped default (`MAIA_OTLP_TRACES_ENDPOINT` unset) and it makes the
    // emission count an observation rather than a tautology.
    cfg.endpoint = undefined;
    const N = 5_000;
    let emitted = 0;
    let framesEntered = 0;
    let wrongResult = 0;
    setSpanSink(() => {
      emitted++;
    });
    const w = await countWork(async () => {
      for (let i = 0; i < N; i++) {
        const out = await withSpan(SPAN.TURN, async () => {
          if (currentSpan() !== null) framesEntered++;
          return i;
        });
        if (out !== i) wrongResult++;
      }
    });
    expect(framesEntered, 'disabled withSpan entered a span context').toBe(0);
    expect(wrongResult, 'disabled withSpan altered the callback result').toBe(0);
    expect(emitted, 'a disabled span reached the sink').toBe(0);
    expect(w.randomBytes, `${w.randomBytes} randomBytes calls for ${N} disabled spans`).toBe(0);
    expect(w.createHash).toBe(0);
    expect(w.randomUUID).toBe(0);
    expect(w.json).toBe(0);
  }, 60_000);

  it('an enabled span does a FIXED, counted amount of expensive work per span', async () => {
    // The clock-free assertion, and the one that carries the sensitivity. It
    // states the hot path's contract in units that do not move between an idle
    // laptop, a loaded runner, Node 22.18 and Node 26:
    //
    //   two ids minted (16 bytes of trace id + 8 of span id), NOTHING hashed
    //   (`MAIA_OTLP_SAMPLE_RATIO=1` must short-circuit the sampler before it
    //   reaches SHA-256), NOTHING serialized, exactly one span emitted.
    //
    // These are exact equalities on purpose. An accidental deep clone
    // (`JSON.parse(JSON.stringify(attrs))` in `emit`), a digest computed per
    // call, a second id minted per span — the named regression classes — each
    // move one of these numbers off its budget, deterministically, on the
    // first run. Lowering one of them is a deliberate edit to this test, which
    // is what a budget is for.
    cfg.endpoint = 'http://collector:4318/v1/traces';
    const N = 2_000;
    let emitted = 0;
    setSpanSink(() => {
      emitted++;
    });
    const w = await countWork(async () => {
      for (let i = 0; i < N; i++) await withSpan(SPAN.TURN, async () => i);
    });
    expect(emitted, 'one emission per span').toBe(N);
    expect(w.randomBytes / N, `${w.randomBytes} randomBytes calls for ${N} spans`).toBe(2);
    expect(w.randomBytesBytes / N, 'bytes of randomness per span').toBe(24);
    expect(w.createHash, 'ratio=1 must short-circuit before SHA-256').toBe(0);
    expect(w.randomUUID).toBe(0);
    expect(w.json, 'nothing on the span hot path may serialize').toBe(0);
  }, 60_000);

  it('an enabled span costs a small multiple of the work it is required to do', async () => {
    // The timed assertion, kept because a counter cannot see a regression that
    // adds no new primitive — a regex recompiled per call, an O(n) walk over
    // the attribute set. Its baseline is `irreducibleSpanWork` (see there for
    // why): same order of magnitude, same primitives, measured in the same
    // interleaved rounds.
    //
    // Measured on a 4-vCPU box with six CPU burners pinning every core, 12
    // runs per Node version:
    //
    //            Node 22.22        Node 26.7
    //   this     1.0x - 1.7x       1.3x - 1.7x     (0/12 red, 0/12 red)
    //   old      9.7x - 92.9x     89.8x - 152.3x   (3/12 red, 5/12 red)
    //
    // The absolute cost of BOTH arms inflated 5-8x under that load (20µs →
    // 100-170µs per span) and the ratio did not move, because both arms are
    // built from the same primitives and inflate together. That is also why
    // the two Node lanes agree here and disagreed by an order of magnitude
    // before: the old denominator was a bare async frame, and Node 26 made
    // bare async frames cheaper without making `randomBytes` cheaper.
    //
    // The bound is 4: 2.4x over the worst round ever observed on either Node,
    // so noise cannot reach it, and still well under what a regression of the
    // class this exists to catch reports — a regex recompiled per call, the
    // one regression that adds no COUNTABLE primitive and so is invisible to
    // the test above, put it at 5.1x-8.1x on 12 of 12 runs.
    cfg.endpoint = 'http://collector:4318/v1/traces';
    const runs = 5;
    const iterations = 2_000;
    let emitted = 0;
    setSpanSink(() => {
      emitted++;
    });
    const c = await compareAsync(
      runs,
      iterations,
      async (i) => {
        irreducibleSpanWork();
        return i;
      },
      async (i) => withSpan(SPAN.TURN, async () => i),
    );
    expect(emitted, 'the candidate arm really emitted spans').toBe(
      (runs + WARMUP_ROUNDS) * iterations,
    );
    expect(c.ratio, report('enabled span vs its irreducible work', c)).toBeLessThan(4);
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
    //
    // `maia_context_load_ms` / `maia_context_slices_total` estavam neste laço
    // e foram aposentadas na review da PR #554 (a carga de contexto do turno já
    // se mede por `maia_turn_context_*`). Trocadas por outras duas famílias da
    // mesma entrega para preservar a aritmética abaixo — o que este caso mede é
    // cardinalidade por turno, não estas famílias em particular.
    for (let i = 0; i < 500; i++) {
      counter(METRIC.TOOL_DISPATCH, { tool: 'listar_lancamentos', result: 'ok' });
      histogram(METRIC.TOOL_DURATION_MS, i, { tool: 'listar_lancamentos', result: 'ok' });
      histogram(METRIC.STAGE_DURATION_MS, i, { stage: 'runtime_trace_envelope' });
      counter(METRIC.TURN_COMPLETED, { outcome: 'completed' });
    }
    const lines = (await renderPrometheus()).split('\n').filter(Boolean).length;
    // 2 counters + 2 histograms (9 bucket lines + sum + count each) = 24.
    expect(lines, `500 turns produced ${lines} series`).toBeLessThan(40);
  });

  it('os quinze emissores novos da #535 não criam UMA série sequer', async () => {
    // O orçamento de cardinalidade desta entrega, medido em vez de afirmado.
    //
    // A #535 fechou a lacuna "declarado mas nunca emitido" adicionando quinze
    // emissores no caminho quente. A pergunta que decide se isso é barato não é
    // "quanto custa um span" (o caso acima já responde: zero com tracing OFF) —
    // é se algum deles carrega uma dimensão nova para a superfície do
    // Prometheus. Nenhum carrega, e a razão é estrutural: TODOS emitem só span.
    // Atributo de span vive num span exportado e não cria série temporal
    // (`taxonomy.ts` §4), então `LABEL_CARDINALITY_BUDGET` fica intocado.
    //
    // A verificação é sobre o que SOBRA no registry: cem passagens por cada
    // wrapper, com tracing LIGADO e o sink contando, e o `/metrics` continua
    // exatamente do tamanho que estava.
    cfg.endpoint = 'http://127.0.0.1:1/v1/traces';
    let spans = 0;
    setSpanSink(() => {
      spans++;
    });
    const antes = (await renderPrometheus()).split('\n').filter(Boolean).length;
    const {
      instrumentAudienceResolve,
      instrumentConstitutionalCheck,
      instrumentDecisionEvaluate,
      instrumentHandlerExecute,
      instrumentIdempotencyClaim,
      instrumentIdentityResolve,
      instrumentOutboundCommit,
      instrumentPermissionCheck,
      instrumentPreturnGraph,
      instrumentProcedureSelect,
      instrumentPromptRender,
      instrumentReactIteration,
      instrumentRiskClassify,
      instrumentRoleSelect,
      instrumentTurnComplete,
    } = await import('@/observability/instrumentation.js');

    for (let i = 0; i < 100; i++) {
      await instrumentIdentityResolve(async () => ({ kind: 'resolved' }));
      await instrumentAudienceResolve(
        async () => ({ ok: true }),
        () => 'resolved' as const,
      );
      await instrumentPreturnGraph(2, async () => null);
      await instrumentProcedureSelect(async () => ({ decision: 'none' }));
      await instrumentRoleSelect(async () => ({ action: 'keep_current' }));
      await instrumentDecisionEvaluate(
        async () => ({ mode: 'act' }),
        (v) => ({ decision: v.mode, blocked: false }),
      );
      await instrumentRiskClassify(async () => ({
        level: 'low',
        requires_human_review: false,
      }));
      await instrumentPromptRender(async () => ({ messages: [1, 2, 3] }));
      await instrumentReactIteration(1, async () => null);
      instrumentConstitutionalCheck('listar', () => null, () => 'ok');
      instrumentPermissionCheck('listar', 1, () => null, () => 'allowed');
      await instrumentIdempotencyClaim('listar', async () => ({}), () => 'reserved');
      await instrumentHandlerExecute('listar', async () => null);
      await instrumentOutboundCommit(
        async () => ({ committed: true }),
        () => 'committed',
      );
      await instrumentTurnComplete('reply_delivered', async () => undefined);
    }

    // Os spans SAÍRAM — senão isto mediria a ausência de instrumentação, que é
    // trivialmente barata e não é o que se quer afirmar. E são os QUINZE: um
    // wrapper esquecido nesta lista sairia do orçamento sem ninguém notar, que
    // é a forma silenciosa deste caso falhar.
    expect(spans, 'nenhum span foi emitido; o caso não mediria nada').toBe(15 * 100);
    const depois = (await renderPrometheus()).split('\n').filter(Boolean).length;
    expect(
      depois - antes,
      `1500 spans dos emissores novos criaram ${depois - antes} séries novas`,
    ).toBe(0);
  }, 60_000);
});
