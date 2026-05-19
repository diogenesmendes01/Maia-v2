/**
 * P9d — `enforcement.ts` unit tests (Architecture Lock).
 *
 * This suite enforces the **caller contract** documented in
 * `enforcement.ts`: every `PolicyOutcome` MUST map deterministically to a
 * single `EnforcementAction.kind`, and `evaluation_error` MUST NEVER produce
 * an `allow` action. This is the canonical mapping every PEP MUST use.
 *
 * Test cases:
 *  1. Outcome × effect.action → EnforcementAction.kind table is exhaustive.
 *  2. `evaluation_error` → `block` (NEVER `allow`, NEVER `pass`).
 *  3. `not_applicable` → `pass` (NEVER `allow`, NEVER `block`).
 *  4. Property test: for any PolicyDecision shape, `enforce()` never throws
 *     and never returns `kind: 'allow'` when outcome was `evaluation_error`.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { enforce } from '@/governance/policy-dsl/enforcement.js';
import type {
  PolicyDecision,
  PolicyEffect,
  PolicyOutcome,
} from '@/governance/policy-dsl/types.js';

const baseDiagnostics = {
  predicate_depth_visited: 0,
  field_lookups: 0,
  regex_cache_hits: 0,
  regex_compiled: 0,
};

function decision(
  outcome: PolicyOutcome,
  effect?: PolicyEffect,
  errors: PolicyDecision['errors'] = [],
): PolicyDecision {
  return {
    outcome,
    matched: outcome === 'matched',
    effect,
    errors,
    diagnostics: baseDiagnostics,
  };
}

describe('enforce — matched outcome maps effect.action correctly', () => {
  it.each([
    ['allow', 'allow'],
    ['block', 'block'],
    ['require_dual_approval', 'block'],
    ['warn', 'observe'],
    ['log', 'observe'],
  ])('effect.action=%s → kind=%s', (action, expectedKind) => {
    const action_ = action as PolicyEffect['action'];
    const d = decision('matched', { action: action_ });
    const result = enforce(d);
    expect(result.kind).toBe(expectedKind);
    if (result.kind !== 'pass') {
      expect(result.reason).toContain('matched');
    }
  });
});

describe('enforce — not_matched outcome', () => {
  it('not_matched → kind=pass, reason=not_matched', () => {
    const result = enforce(decision('not_matched'));
    expect(result.kind).toBe('pass');
    expect(result.reason).toBe('not_matched');
  });
});

describe('enforce — not_applicable outcome', () => {
  it('not_applicable → kind=pass, reason=not_applicable', () => {
    const result = enforce(decision('not_applicable'));
    expect(result.kind).toBe('pass');
    expect(result.reason).toBe('not_applicable');
  });

  it('not_applicable NEVER produces allow', () => {
    // Architecture Lock: a missing field cannot be silently approved as a
    // matched=allow rule. PEPs that hand-roll mapping might mis-map this.
    const result = enforce(decision('not_applicable'));
    expect(result.kind).not.toBe('allow');
  });
});

describe('enforce — evaluation_error MUST block (Architecture Lock)', () => {
  it('evaluation_error → kind=block, reason=evaluation_error', () => {
    const d = decision('evaluation_error', undefined, [
      { code: 'missing_field', message: 'x' },
    ]);
    const result = enforce(d);
    expect(result.kind).toBe('block');
    expect(result.reason).toBe('evaluation_error');
    if (result.reason === 'evaluation_error') {
      expect(result.error_codes).toContain('missing_field');
    }
  });

  it('evaluation_error NEVER produces allow', () => {
    // Architecture Lock: this is THE invariant. A failed evaluation MUST
    // fail-closed. If this ever flips, callers will silently let corrupted
    // policies through.
    for (const code of [
      'predicate_depth_exceeded',
      'malformed_predicate',
      'malformed_branch_child',
      'invalid_effect',
      'missing_field',
      'regex_pattern_unsafe',
    ] as const) {
      const result = enforce(
        decision('evaluation_error', undefined, [{ code, message: 'x' }]),
      );
      expect(result.kind).not.toBe('allow');
      expect(result.kind).not.toBe('pass');
      expect(result.kind).toBe('block');
    }
  });

  it('evaluation_error NEVER produces pass', () => {
    const result = enforce(decision('evaluation_error'));
    expect(result.kind).not.toBe('pass');
  });
});

describe('enforce — property: evaluation_error MUST always block', () => {
  // Architecture Lock property test: regardless of what errors the
  // evaluator captured (or didn't), `evaluation_error` outcome MUST map to
  // `block`. No path can sneak through to `allow`.
  it('any evaluation_error outcome → kind=block (10k random inputs)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            code: fc.string({ minLength: 1, maxLength: 32 }),
            message: fc.string({ maxLength: 64 }),
          }),
          { maxLength: 8 },
        ),
        (errors) => {
          const result = enforce(
            decision(
              'evaluation_error',
              undefined,
              errors as PolicyDecision['errors'],
            ),
          );
          expect(result.kind).toBe('block');
          expect(result.kind).not.toBe('allow');
          expect(result.kind).not.toBe('pass');
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe('enforce — totality property', () => {
  it('never throws for any PolicyDecision-shaped input', () => {
    const outcomeArb = fc.constantFrom(
      'matched',
      'not_matched',
      'not_applicable',
      'evaluation_error',
    ) as fc.Arbitrary<PolicyOutcome>;
    const actionArb = fc.constantFrom(
      'allow',
      'block',
      'require_dual_approval',
      'warn',
      'log',
    ) as fc.Arbitrary<PolicyEffect['action']>;
    const effectArb = fc.option(
      fc.record({
        action: actionArb,
        message: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
      }) as fc.Arbitrary<PolicyEffect>,
      { nil: undefined },
    );

    fc.assert(
      fc.property(outcomeArb, effectArb, (outcome, effect) => {
        const d = decision(outcome, effect ?? undefined);
        const result = enforce(d);
        expect(result).toBeDefined();
        expect(typeof result.kind).toBe('string');
        // Critical invariant: any error outcome maps to block.
        if (outcome === 'evaluation_error') {
          expect(result.kind).toBe('block');
        }
      }),
      { numRuns: 1000 },
    );
  });
});
