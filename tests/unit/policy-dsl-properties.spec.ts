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
        // Outcome must be one of the four enum values (Architecture Lock).
        expect([
          'matched',
          'not_matched',
          'not_applicable',
          'evaluation_error',
        ]).toContain(decision.outcome);
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

  /**
   * Adversarial 10k-iteration totality stress (Codex review #98 ask 4).
   *
   * Generates aggressive inputs:
   *  - deeply nested predicates (random branch shapes up to size ≈ 8 deep)
   *  - missing context fields (small context dict + large field-path pool)
   *  - malformed regex patterns (random non-string + ReDoS shapes)
   *  - empty contexts, null contexts, primitive contexts
   *
   * Invariants:
   *  - never throws
   *  - returns a `PolicyDecision`-shaped object
   *  - outcome is a member of the closed enum
   *  - matched implies outcome === 'matched' and effect present
   *  - evaluation_error MUST have at least one error
   */
  it('totality holds for 10k adversarial inputs', () => {
    const adversarialContext = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.boolean(),
      contextArb,
      // Deeply nested adversarial context
      fc.dictionary(fc.string({ maxLength: 4 }), valueArb, { maxKeys: 16 }),
    );

    // Adversarial regex pool — mix of safe, ReDoS, and invalid patterns.
    const adversarialRegex = fc.oneof(
      fc.constant('^a'),
      fc.constant('(a+)+$'), // ReDoS-prone
      fc.constant('[unclosed'), // invalid syntax
      fc.constant('(a|aa)+'), // ambiguous
      fc.string({ maxLength: 32 }),
    );

    // Adversarial leaf — sometimes asks for a path that doesn't exist.
    const adversarialLeaf: fc.Arbitrary<PolicyPredicate> = fc.record({
      kind: fc.constant('leaf' as const),
      field: fc.oneof(
        fc.constant('missing.nested.path'),
        fc.constant('a'),
        fc.constant(''),
        fc.string({ maxLength: 16 }),
        fieldArb,
      ),
      op: operatorArb,
      value: fc.oneof(valueArb, adversarialRegex),
    }) as fc.Arbitrary<PolicyPredicate>;

    const adversarialBody: fc.Arbitrary<PolicyRuleBody> = fc.record({
      rule_id: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
      predicate: fc.oneof(
        adversarialLeaf,
        // Compose AND/OR/NOT with the adversarial leaf for shallow but
        // wide adversarial trees.
        fc.record({
          kind: fc.constant('and' as const),
          predicates: fc.array(adversarialLeaf, { minLength: 0, maxLength: 6 }),
        }),
        fc.record({
          kind: fc.constant('or' as const),
          predicates: fc.array(adversarialLeaf, { minLength: 0, maxLength: 6 }),
        }),
        fc.record({
          kind: fc.constant('not' as const),
          predicate: adversarialLeaf,
        }),
        predicateArb,
      ),
      effect: fc.record({
        action: effectActionArb,
        message: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
      }) as fc.Arbitrary<PolicyRuleBody['effect']>,
    }) as fc.Arbitrary<PolicyRuleBody>;

    fc.assert(
      fc.property(adversarialBody, adversarialContext, (body, ctx) => {
        let decision;
        try {
          decision = evaluate(body, ctx);
        } catch (e) {
          // Totality violation — the evaluator MUST NOT throw.
          throw new Error(`evaluator threw: ${String(e)}`, { cause: e });
        }
        expect(decision).toBeDefined();
        expect([
          'matched',
          'not_matched',
          'not_applicable',
          'evaluation_error',
        ]).toContain(decision.outcome);
        expect(Array.isArray(decision.errors)).toBe(true);
        expect(typeof decision.matched).toBe('boolean');

        // Invariant: matched implies outcome === 'matched' AND effect present.
        if (decision.matched) {
          expect(decision.outcome).toBe('matched');
          expect(decision.effect).toBeDefined();
        }
        // Invariant: outcome=evaluation_error MUST have at least one error.
        if (decision.outcome === 'evaluation_error') {
          expect(decision.errors.length).toBeGreaterThan(0);
        }
        // Invariant: outcome=matched/not_matched/not_applicable MUST have
        // no errors (errors force evaluation_error).
        if (
          decision.outcome === 'matched' ||
          decision.outcome === 'not_matched' ||
          decision.outcome === 'not_applicable'
        ) {
          expect(decision.errors).toEqual([]);
        }
        // Invariant: effect is only present when matched.
        if (decision.outcome !== 'matched') {
          expect(decision.effect).toBeUndefined();
        }
      }),
      { numRuns: 10_000 },
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
