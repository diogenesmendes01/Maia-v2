/**
 * P9d — `evaluator.ts` unit tests.
 *
 * Coverage matrix:
 *  - 10 leaf operators (eq/neq/in/not_in/gt/gte/lt/lte/contains/matches),
 *    happy + edge cases (type mismatches, NaN, missing fields).
 *  - Boolean connectives (AND/OR/NOT) including empty-array identities and
 *    short-circuit behaviour.
 *  - Decision shape (matched, effect, errors, diagnostics).
 *  - Total behaviour: malformed inputs never throw.
 *  - Bounds: depth-exceeded predicates produce structured errors.
 *  - ReDoS guard: unsafe patterns + over-long inputs surface as errors and
 *    the leaf evaluates to false.
 *  - Decision is byte-identical for byte-identical inputs (determinism).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate } from '@/governance/policy-dsl/evaluator.js';
import { resetRegexCache } from '@/governance/policy-dsl/regex-cache.js';
import {
  MAX_PREDICATE_DEPTH,
  MAX_REGEX_INPUT_LENGTH,
} from '@/governance/policy-dsl/constants.js';
import type {
  PolicyPredicate,
  PolicyRuleBody,
} from '@/governance/policy-dsl/types.js';

afterEach(() => {
  resetRegexCache();
});

function leaf(field: string, op: string, value: unknown): PolicyPredicate {
  return { kind: 'leaf', field, op: op as never, value: value as never };
}

function blockBody(predicate: PolicyPredicate, message = 'blocked'): PolicyRuleBody {
  return {
    rule_id: 'r1',
    predicate,
    effect: { action: 'block', message },
  };
}

describe('evaluate — operator semantics', () => {
  it('eq matches primitives strictly', () => {
    const decision = evaluate(blockBody(leaf('a', 'eq', 1)), { a: 1 });
    expect(decision.matched).toBe(true);
    expect(decision.effect?.action).toBe('block');
    expect(decision.errors).toEqual([]);
  });

  it('eq fails on type mismatch (no coercion)', () => {
    const decision = evaluate(blockBody(leaf('a', 'eq', '1')), { a: 1 });
    expect(decision.matched).toBe(false);
  });

  it('eq deep-equals nested objects', () => {
    const ctx = { a: { b: [1, 2, { c: true }] } };
    const decision = evaluate(
      blockBody(leaf('a', 'eq', { b: [1, 2, { c: true }] })),
      ctx,
    );
    expect(decision.matched).toBe(true);
  });

  it('neq is the inverse of eq', () => {
    const decision = evaluate(blockBody(leaf('a', 'neq', 2)), { a: 1 });
    expect(decision.matched).toBe(true);
  });

  it('in matches when element is in array', () => {
    const d = evaluate(blockBody(leaf('a', 'in', [1, 2, 3])), { a: 2 });
    expect(d.matched).toBe(true);
  });

  it('in returns false when value is not an array', () => {
    const d = evaluate(blockBody(leaf('a', 'in', 'not-array')), { a: 'a' });
    expect(d.matched).toBe(false);
  });

  it('not_in returns true when element absent', () => {
    const d = evaluate(blockBody(leaf('a', 'not_in', [1, 2])), { a: 9 });
    expect(d.matched).toBe(true);
  });

  it.each([
    ['gt', 5, 4, true],
    ['gt', 4, 5, false],
    ['gt', 5, 5, false],
    ['gte', 5, 5, true],
    ['lt', 3, 5, true],
    ['lte', 3, 3, true],
  ])('%s(%i, %i) → %s', (op, left, right, expected) => {
    const d = evaluate(blockBody(leaf('a', op, right)), { a: left });
    expect(d.matched).toBe(expected);
  });

  it('numeric ops return false for non-numeric operands', () => {
    expect(evaluate(blockBody(leaf('a', 'gt', 1)), { a: 'x' }).matched).toBe(false);
    expect(evaluate(blockBody(leaf('a', 'gt', 1)), { a: NaN }).matched).toBe(false);
    expect(evaluate(blockBody(leaf('a', 'gt', NaN)), { a: 5 }).matched).toBe(false);
  });

  it('contains works for strings (substring)', () => {
    const d = evaluate(blockBody(leaf('a', 'contains', 'foo')), { a: 'xfooy' });
    expect(d.matched).toBe(true);
  });

  it('contains works for arrays (membership)', () => {
    const d = evaluate(
      blockBody(leaf('a', 'contains', { x: 1 })),
      { a: [{ x: 0 }, { x: 1 }] },
    );
    expect(d.matched).toBe(true);
  });

  it('contains returns false for unsupported operand combos', () => {
    expect(evaluate(blockBody(leaf('a', 'contains', 'x')), { a: 5 }).matched).toBe(false);
  });

  it('matches honours simple regex', () => {
    const d = evaluate(blockBody(leaf('a', 'matches', '^foo')), { a: 'foobar' });
    expect(d.matched).toBe(true);
  });

  it('matches returns false when input is not a string', () => {
    const d = evaluate(blockBody(leaf('a', 'matches', '^foo')), { a: 42 });
    expect(d.matched).toBe(false);
  });
});

describe('evaluate — boolean connectives', () => {
  it('AND short-circuits at first false', () => {
    const ctx = { a: 1, b: 2 };
    const d = evaluate(
      blockBody({
        kind: 'and',
        predicates: [leaf('a', 'eq', 1), leaf('b', 'eq', 99)],
      }),
      ctx,
    );
    expect(d.matched).toBe(false);
  });

  it('AND with all true matches', () => {
    const d = evaluate(
      blockBody({
        kind: 'and',
        predicates: [leaf('a', 'eq', 1), leaf('b', 'eq', 2)],
      }),
      { a: 1, b: 2 },
    );
    expect(d.matched).toBe(true);
  });

  it('AND with empty predicates is vacuously true', () => {
    const d = evaluate(blockBody({ kind: 'and', predicates: [] }), {});
    expect(d.matched).toBe(true);
  });

  it('OR short-circuits at first true', () => {
    const d = evaluate(
      blockBody({
        kind: 'or',
        predicates: [leaf('a', 'eq', 99), leaf('b', 'eq', 2)],
      }),
      { a: 1, b: 2 },
    );
    expect(d.matched).toBe(true);
  });

  it('OR with all false fails', () => {
    const d = evaluate(
      blockBody({
        kind: 'or',
        predicates: [leaf('a', 'eq', 99), leaf('b', 'eq', 99)],
      }),
      { a: 1, b: 2 },
    );
    expect(d.matched).toBe(false);
  });

  it('OR with empty predicates is vacuously false', () => {
    const d = evaluate(blockBody({ kind: 'or', predicates: [] }), {});
    expect(d.matched).toBe(false);
  });

  it('NOT inverts inner result', () => {
    const d = evaluate(
      blockBody({ kind: 'not', predicate: leaf('a', 'eq', 99) }),
      { a: 1 },
    );
    expect(d.matched).toBe(true);
  });
});

describe('evaluate — decision shape', () => {
  it('attaches the effect only when matched', () => {
    const matched = evaluate(blockBody(leaf('a', 'eq', 1)), { a: 1 });
    expect(matched.effect?.action).toBe('block');
    const unmatched = evaluate(blockBody(leaf('a', 'eq', 2)), { a: 1 });
    expect(unmatched.effect).toBeUndefined();
  });

  it('echoes rule_id when present', () => {
    const decision = evaluate(blockBody(leaf('a', 'eq', 1)), { a: 1 });
    expect(decision.rule_id).toBe('r1');
  });

  it('reports diagnostics counters', () => {
    const decision = evaluate(blockBody(leaf('a.b.c', 'eq', 1)), {
      a: { b: { c: 1 } },
    });
    expect(decision.diagnostics.field_lookups).toBe(1);
    expect(decision.diagnostics.predicate_depth_visited).toBeGreaterThanOrEqual(0);
  });
});

describe('evaluate — totality and error capture', () => {
  it('returns inert decision when rule_body is null', () => {
    const decision = evaluate(null, {});
    expect(decision.matched).toBe(false);
    expect(decision.errors[0]?.code).toBe('malformed_predicate');
  });

  it('returns inert decision when predicate is missing', () => {
    const decision = evaluate({ predicate: undefined as never, effect: { action: 'block' } }, {});
    expect(decision.matched).toBe(false);
    expect(decision.errors[0]?.code).toBe('malformed_predicate');
  });

  it('captures unknown predicate kinds without throwing', () => {
    const decision = evaluate(
      {
        predicate: { kind: 'mystery' as never } as PolicyPredicate,
        effect: { action: 'block' },
      },
      {},
    );
    expect(decision.matched).toBe(false);
    expect(decision.errors[0]?.code).toBe('malformed_predicate');
  });

  it('depth-exceeded predicates surface predicate_depth_exceeded', () => {
    // Build an AND chain MAX_PREDICATE_DEPTH+5 levels deep.
    let pred: PolicyPredicate = leaf('a', 'eq', 1);
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 5; i += 1) {
      pred = { kind: 'and', predicates: [pred] };
    }
    const decision = evaluate(blockBody(pred), { a: 1 });
    expect(decision.matched).toBe(false);
    expect(decision.errors.some((e) => e.code === 'predicate_depth_exceeded')).toBe(true);
  });

  it('field-path-too-deep yields field_path_depth_exceeded', () => {
    const tooDeep = Array.from({ length: 20 }, () => 'a').join('.');
    const decision = evaluate(blockBody(leaf(tooDeep, 'eq', 1)), { a: 1 });
    expect(decision.matched).toBe(false);
    expect(decision.errors[0]?.code).toBe('field_path_depth_exceeded');
  });

  it('matches rejects inputs longer than MAX_REGEX_INPUT_LENGTH', () => {
    const longInput = 'a'.repeat(MAX_REGEX_INPUT_LENGTH + 1);
    const d = evaluate(blockBody(leaf('a', 'matches', '^a')), { a: longInput });
    expect(d.matched).toBe(false);
    expect(d.errors[0]?.code).toBe('regex_input_too_long');
  });

  it('matches rejects unsafe regex patterns', () => {
    const d = evaluate(blockBody(leaf('a', 'matches', '(a+)+$')), { a: 'aaa' });
    expect(d.matched).toBe(false);
    expect(d.errors[0]?.code).toBe('regex_pattern_unsafe');
  });

  it('matches with invalid regex surfaces regex_evaluation_failed', () => {
    const d = evaluate(blockBody(leaf('a', 'matches', '[unclosed')), { a: 'x' });
    expect(d.matched).toBe(false);
    expect(d.errors[0]?.code).toBe('regex_evaluation_failed');
  });

  it('missing field for equality op yields not_applicable (no error)', () => {
    // Tightened by Codex review #98: previously this was just `matched=false`
    // with no signal to the PEP that the rule never had a chance to apply.
    const d = evaluate(blockBody(leaf('a', 'eq', 1)), { b: 2 });
    expect(d.matched).toBe(false);
    expect(d.outcome).toBe('not_applicable');
    expect(d.errors).toEqual([]);
  });
});

describe('evaluate — missing-field semantics (per-operator, Codex review #98)', () => {
  // For equality / membership / string operators a missing field cannot
  // answer "does this rule apply?" — outcome MUST be `not_applicable` so
  // PEPs can distinguish "rule said no" from "rule had no data".
  it.each([
    ['eq', 1],
    ['neq', 1],
    ['in', [1, 2]],
    ['not_in', [1, 2]],
    ['contains', 'foo'],
    ['matches', '^foo'],
  ])('%s on missing field → not_applicable, no errors', (op, value) => {
    const d = evaluate(blockBody(leaf('missing.path', op, value)), {});
    expect(d.outcome).toBe('not_applicable');
    expect(d.matched).toBe(false);
    expect(d.errors).toEqual([]);
  });

  // Critical Codex finding: `neq` against a missing field previously returned
  // `!deepEqual(undefined, value)` → true → matched! That was a silent allow.
  it('neq on missing field does NOT silently match (was Codex critical)', () => {
    const d = evaluate(blockBody(leaf('role', 'neq', 'admin')), {});
    expect(d.matched).toBe(false);
    expect(d.outcome).toBe('not_applicable');
  });

  // Critical Codex finding: `not_in` against missing field returned true
  // → "role not in [banned]" matched on absent role → silent allow.
  it('not_in on missing field does NOT silently match (was Codex critical)', () => {
    const d = evaluate(blockBody(leaf('role', 'not_in', ['banned'])), {});
    expect(d.matched).toBe(false);
    expect(d.outcome).toBe('not_applicable');
  });

  // For ordinal ops, missing context is an evaluation_error (cannot coerce
  // undefined to a number without changing meaning). PEPs MUST block.
  it.each(['gt', 'gte', 'lt', 'lte'])('%s on missing field → evaluation_error: missing_field', (op) => {
    const d = evaluate(blockBody(leaf('amount', op, 100)), {});
    expect(d.outcome).toBe('evaluation_error');
    expect(d.matched).toBe(false);
    expect(d.errors.some((e) => e.code === 'missing_field')).toBe(true);
  });

  // NOT propagation: `not(not_applicable)` MUST stay `not_applicable`,
  // NOT become `matched=true`. Inverting "we don't know" doesn't give us
  // a definite answer.
  it('not(not_applicable) propagates not_applicable (not inverted to matched)', () => {
    const d = evaluate(
      blockBody({ kind: 'not', predicate: leaf('a', 'eq', 1) }),
      { b: 2 },
    );
    expect(d.outcome).toBe('not_applicable');
    expect(d.matched).toBe(false);
  });

  // AND with one not_applicable side and one true side → not_applicable
  // (Kleene three-valued semantics). A definite false still wins.
  it('AND: true && not_applicable → not_applicable', () => {
    const d = evaluate(
      blockBody({
        kind: 'and',
        predicates: [leaf('present', 'eq', 1), leaf('missing', 'eq', 2)],
      }),
      { present: 1 },
    );
    expect(d.outcome).toBe('not_applicable');
  });

  it('AND: false && not_applicable → false (definite false wins)', () => {
    const d = evaluate(
      blockBody({
        kind: 'and',
        predicates: [leaf('present', 'eq', 999), leaf('missing', 'eq', 2)],
      }),
      { present: 1 },
    );
    expect(d.outcome).toBe('not_matched');
  });

  it('OR: false || not_applicable → not_applicable', () => {
    const d = evaluate(
      blockBody({
        kind: 'or',
        predicates: [leaf('present', 'eq', 999), leaf('missing', 'eq', 2)],
      }),
      { present: 1 },
    );
    expect(d.outcome).toBe('not_applicable');
  });

  it('OR: true || not_applicable → matched (definite true wins)', () => {
    const d = evaluate(
      blockBody({
        kind: 'or',
        predicates: [leaf('present', 'eq', 1), leaf('missing', 'eq', 2)],
      }),
      { present: 1 },
    );
    expect(d.outcome).toBe('matched');
  });
});

describe('evaluate — branch fail-closed (Codex review #98 high)', () => {
  it('AND with null child fails closed (was silently skipped)', () => {
    // Previously: `{kind:'and', predicates:[null]}` evaluated to vacuously
    // true and bypassed governance. Now it surfaces as evaluation_error.
    const body = {
      rule_id: 'r',
      predicate: { kind: 'and', predicates: [null] } as never,
      effect: { action: 'block' } as never,
    };
    const d = evaluate(body, {});
    expect(d.outcome).toBe('evaluation_error');
    expect(d.matched).toBe(false);
    expect(d.errors.some((e) => e.code === 'malformed_branch_child')).toBe(true);
  });

  it('OR with undefined child fails closed', () => {
    const body = {
      rule_id: 'r',
      predicate: { kind: 'or', predicates: [undefined] } as never,
      effect: { action: 'block' } as never,
    };
    const d = evaluate(body, {});
    expect(d.outcome).toBe('evaluation_error');
    expect(d.errors.some((e) => e.code === 'malformed_branch_child')).toBe(true);
  });

  it('AND with non-object child fails closed', () => {
    const body = {
      rule_id: 'r',
      predicate: { kind: 'and', predicates: ['not-a-predicate'] } as never,
      effect: { action: 'block' } as never,
    };
    const d = evaluate(body, {});
    expect(d.outcome).toBe('evaluation_error');
    expect(d.errors.some((e) => e.code === 'malformed_branch_child')).toBe(true);
  });
});

describe('evaluate — matched-effect validity (Codex review #98 high)', () => {
  it('matched decision with missing effect.action → evaluation_error', () => {
    const body = {
      rule_id: 'r',
      predicate: leaf('a', 'eq', 1),
      effect: {} as never,
    };
    const d = evaluate(body, { a: 1 });
    expect(d.outcome).toBe('evaluation_error');
    expect(d.matched).toBe(false);
    expect(d.errors.some((e) => e.code === 'invalid_effect')).toBe(true);
  });

  it('matched decision with unknown effect.action → evaluation_error', () => {
    const body = {
      rule_id: 'r',
      predicate: leaf('a', 'eq', 1),
      effect: { action: 'self-destruct' as never },
    };
    const d = evaluate(body, { a: 1 });
    expect(d.outcome).toBe('evaluation_error');
    expect(d.errors.some((e) => e.code === 'invalid_effect')).toBe(true);
  });

  it('matched decision with null effect → evaluation_error', () => {
    const body = {
      rule_id: 'r',
      predicate: leaf('a', 'eq', 1),
      effect: null as never,
    };
    const d = evaluate(body, { a: 1 });
    expect(d.outcome).toBe('evaluation_error');
    expect(d.errors.some((e) => e.code === 'invalid_effect')).toBe(true);
  });
});

describe('evaluate — determinism', () => {
  it('produces identical results across runs for the same inputs', () => {
    const body = blockBody({
      kind: 'and',
      predicates: [
        leaf('a', 'gte', 0),
        leaf('b', 'matches', '^foo'),
        { kind: 'not', predicate: leaf('c', 'in', [1, 2, 3]) },
      ],
    });
    const ctx = { a: 5, b: 'foobar', c: 99 };
    const first = evaluate(body, ctx);
    const second = evaluate(body, ctx);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
