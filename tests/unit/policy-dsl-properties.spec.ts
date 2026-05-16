/**
 * P9d — Property tests (`fast-check`).
 *
 * The DSL gives us 3 universal properties to verify by random generation:
 *
 *  1. **Totality** — `evaluate()` never throws. For ANY arbitrary input
 *     (including malformed bodies and adversarial contexts) it must return
 *     a `PolicyDecision`.
 *
 *  2. **Determinism** — for any (body, context) pair, two consecutive calls
 *     produce byte-identical decisions. (Catches accidental randomness like
 *     `Date.now()` slipping into a future operator.)
 *
 *  3. **Depth-bound observation** — when a deeply-nested AND chain crosses
 *     `MAX_PREDICATE_DEPTH`, the decision MUST surface
 *     `predicate_depth_exceeded`. Catches a silent regression that loosens
 *     the bound.
 *
 * We use `fast-check` to drive 200 randomised cases per property by default.
 * The arbitraries are intentionally **broad** — the input space includes
 * shapes the validator would reject (we want totality, not validity).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { evaluate } from '@/governance/policy-dsl/evaluator.js';
import { resetRegexCache } from '@/governance/policy-dsl/regex-cache.js';
import { MAX_PREDICATE_DEPTH } from '@/governance/policy-dsl/constants.js';
import type {
  PolicyPredicate,
  PolicyRuleBody,
} from '@/governance/policy-dsl/types.js';

afterEach(() => {
  resetRegexCache();
});

// Bounded JSON-ish arbitrary: numbers, strings, booleans, null, arrays + records.
const valueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.integer(),
    fc.float({ noNaN: false }),
    fc.string({ maxLength: 16 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 8 }), tie('value'), { maxKeys: 4 }),
  ),
})).value;

const operatorArb = fc.constantFrom(
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'matches',
);

// Field paths up to ~6 segments deep, alphanumeric only.
const fieldArb = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/), { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join('.'));

const leafArb: fc.Arbitrary<PolicyPredicate> = fc.record({
  kind: fc.constant('leaf' as const),
  field: fieldArb,
  op: operatorArb,
  value: valueArb,
}) as fc.Arbitrary<PolicyPredicate>;

// Bounded predicate tree. `fc.letrec` with `depthSize: 'small'` keeps the
// generator's working set well below MAX_PREDICATE_DEPTH most of the time.
const predicateArb: fc.Arbitrary<PolicyPredicate> = fc.letrec((tie) => ({
  predicate: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    fc.record({
      kind: fc.constant('and' as const),
      predicates: fc.array(tie('predicate') as fc.Arbitrary<PolicyPredicate>, {
        minLength: 0,
        maxLength: 4,
      }),
    }),
    fc.record({
      kind: fc.constant('or' as const),
      predicates: fc.array(tie('predicate') as fc.Arbitrary<PolicyPredicate>, {
        minLength: 0,
        maxLength: 4,
      }),
    }),
    fc.record({
      kind: fc.constant('not' as const),
      predicate: tie('predicate') as fc.Arbitrary<PolicyPredicate>,
    }),
  ),
})).predicate as fc.Arbitrary<PolicyPredicate>;

const effectActionArb = fc.constantFrom(
  'allow',
  'block',
  'require_dual_approval',
  'warn',
  'log',
);

const ruleBodyArb: fc.Arbitrary<PolicyRuleBody> = fc.record({
  rule_id: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  predicate: predicateArb,
  effect: fc.record({
    action: effectActionArb,
    message: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
  }) as fc.Arbitrary<PolicyRuleBody['effect']>,
}) as fc.Arbitrary<PolicyRuleBody>;

const contextArb = fc.dictionary(
  fc.string({ maxLength: 8 }),
  valueArb,
  { maxKeys: 8 },
);

describe('property: totality', () => {
  it('evaluate never throws for arbitrary inputs', () => {
    fc.assert(
      fc.property(ruleBodyArb, contextArb, (body, ctx) => {
        const decision = evaluate(body, ctx);
        // Decision shape must always be present.
        expect(decision).toBeDefined();
        expect(typeof decision.matched).toBe('boolean');
        expect(Array.isArray(decision.errors)).toBe(true);
        expect(decision.diagnostics).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });

  it('evaluate never throws even for utterly malformed bodies', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (body, ctx) => {
        const decision = evaluate(body as PolicyRuleBody | null, ctx);
        expect(decision).toBeDefined();
        expect(typeof decision.matched).toBe('boolean');
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: determinism', () => {
  it('two evaluations of the same (body, context) are byte-identical', () => {
    fc.assert(
      fc.property(ruleBodyArb, contextArb, (body, ctx) => {
        // Reset cache between iterations to make sure determinism survives
        // a cold-start scenario (otherwise cache hits could mask a regex
        // counter difference, etc).
        resetRegexCache();
        const a = evaluate(body, ctx);
        const b = evaluate(body, ctx);
        // Diagnostics counters can differ slightly because the regex-cache
        // hit/miss balance changes between the first and second pass. We
        // assert determinism on the *behavioural* fields (everything that
        // affects downstream control flow).
        expect(a.matched).toBe(b.matched);
        expect(a.rule_id).toBe(b.rule_id);
        expect(a.effect).toEqual(b.effect);
        expect(a.errors).toEqual(b.errors);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: depth bound', () => {
  it('predicates deeper than MAX_PREDICATE_DEPTH surface predicate_depth_exceeded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        leafArb,
        (extraDepth, leaf) => {
          let pred: PolicyPredicate = leaf;
          for (let i = 0; i < MAX_PREDICATE_DEPTH + extraDepth; i += 1) {
            pred = { kind: 'and', predicates: [pred] };
          }
          const decision = evaluate(
            { predicate: pred, effect: { action: 'block' } },
            {},
          );
          expect(decision.matched).toBe(false);
          expect(
            decision.errors.some((e) => e.code === 'predicate_depth_exceeded'),
          ).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
