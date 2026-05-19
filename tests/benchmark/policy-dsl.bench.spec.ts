/**
 * P9d — `evaluate()` performance benchmark (`tinybench`).
 *
 * Goal: keep p99 of a "realistic" rule body under `TARGET_P99_MICROS` (1ms).
 *
 * The benchmark runs three workloads:
 *  1. **simple** — single leaf operator (cheap baseline).
 *  2. **realistic** — depth-3 AND/OR/NOT mix with one regex match.
 *  3. **deep_match** — depth-12 AND chain ending in a regex match
 *     (tests cache + depth traversal cost together).
 *
 * The benchmark is **informational** (printed via vitest output, not gated)
 * because flaky CI runners can make percentile assertions noisy. Local runs
 * MUST clear 1ms p99 — track regressions via the printed summary.
 *
 * Run: `npx vitest run tests/benchmark/policy-dsl.bench.ts`
 */
import { describe, it, expect } from 'vitest';
import { Bench } from 'tinybench';
import { evaluate } from '@/governance/policy-dsl/evaluator.js';
import { resetRegexCache } from '@/governance/policy-dsl/regex-cache.js';
import {
  TARGET_P99_MICROS,
} from '@/governance/policy-dsl/constants.js';
import type { PolicyRuleBody } from '@/governance/policy-dsl/types.js';

const simpleBody: PolicyRuleBody = {
  predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 1 },
  effect: { action: 'block' },
};
const simpleCtx = { a: 1 };

const realisticBody: PolicyRuleBody = {
  predicate: {
    kind: 'and',
    predicates: [
      { kind: 'leaf', field: 'channel', op: 'in', value: ['whatsapp', 'sms'] },
      {
        kind: 'or',
        predicates: [
          { kind: 'leaf', field: 'risk_score', op: 'gte', value: 0.7 },
          { kind: 'leaf', field: 'amount', op: 'gt', value: 1000 },
        ],
      },
      {
        kind: 'not',
        predicate: {
          kind: 'leaf',
          field: 'message',
          op: 'matches',
          value: '^ALLOWED:',
        },
      },
    ],
  },
  effect: { action: 'block', message: 'high-risk transaction' },
};
const realisticCtx = {
  channel: 'whatsapp',
  risk_score: 0.85,
  amount: 4500,
  message: 'pay the rent',
};

function makeDeepBody(depth: number): PolicyRuleBody {
  let pred: PolicyRuleBody['predicate'] = {
    kind: 'leaf',
    field: 'tail',
    op: 'matches',
    value: '^[A-Z][a-z]+$',
  };
  for (let i = 0; i < depth; i += 1) {
    pred = { kind: 'and', predicates: [pred, { kind: 'leaf', field: `f${i}`, op: 'eq', value: i }] };
  }
  return { predicate: pred, effect: { action: 'block' } };
}
const deepBody = makeDeepBody(12);
const deepCtx: Record<string, unknown> = { tail: 'Hello' };
for (let i = 0; i < 12; i += 1) deepCtx[`f${i}`] = i;

describe('policy DSL benchmark', () => {
  it(`reports timings (target p99 < ${TARGET_P99_MICROS} micros)`, async () => {
    resetRegexCache();
    // tinybench v6 surfaces stats under `result.latency` (ms-units). Each
    // task runs for `time` ms after `iterations` warmup runs.
    const bench = new Bench({ iterations: 200, time: 250 });
    bench
      .add('simple_leaf', () => {
        evaluate(simpleBody, simpleCtx);
      })
      .add('realistic_mixed', () => {
        evaluate(realisticBody, realisticCtx);
      })
      .add('deep_match', () => {
        evaluate(deepBody, deepCtx);
      });
    await bench.run();
    const rows = bench.tasks.map((t) => {
      const lat = t.result?.latency as
        | { mean?: number; p99?: number; samplesCount?: number }
        | undefined;
      return {
        name: t.name,
        state: t.result?.state ?? 'unknown',
        runs: t.runs,
        mean_us: lat?.mean !== undefined ? +(lat.mean * 1000).toFixed(3) : null,
        p99_us: lat?.p99 !== undefined ? +(lat.p99 * 1000).toFixed(3) : null,
        samples: lat?.samplesCount ?? 0,
      };
    });
    console.log('policy-dsl benchmark:', JSON.stringify(rows, null, 2));
    // Sanity assertion: every workload must have produced runs.
    for (const row of rows) {
      expect(row.runs).toBeGreaterThan(0);
    }
  }, 30_000);
});
