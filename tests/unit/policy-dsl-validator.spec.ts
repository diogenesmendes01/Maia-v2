/**
 * P9d — `validator.ts` unit tests.
 *
 * Coverage targets the 14 validation error codes:
 *  - missing_predicate, missing_effect, missing_effect_action, unknown_effect_action
 *  - missing_predicate_kind, unknown_predicate_kind
 *  - missing_leaf_field, missing_leaf_op, unknown_leaf_op, missing_leaf_value
 *  - in_value_not_array
 *  - predicate_too_deep
 *  - regex_pattern_invalid, regex_pattern_unsafe
 *
 * Validator is **strict** — it accumulates ALL errors so authors see the
 * full picture in one round-trip. Tests assert this accumulation behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { validatePolicyRuleBody } from '@/governance/policy-dsl/validator.js';
import { resetRegexCache } from '@/governance/policy-dsl/regex-cache.js';
import { MAX_PREDICATE_DEPTH } from '@/governance/policy-dsl/constants.js';

afterEach(() => {
  resetRegexCache();
});

describe('validatePolicyRuleBody — root shape', () => {
  it('rejects null/undefined as missing_predicate', () => {
    expect(validatePolicyRuleBody(null).ok).toBe(false);
    expect(validatePolicyRuleBody(undefined).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    const result = validatePolicyRuleBody('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('missing_predicate');
    }
  });

  it('reports missing_predicate when predicate is absent', () => {
    const result = validatePolicyRuleBody({ effect: { action: 'block' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'missing_predicate')).toBe(true);
    }
  });

  it('reports missing_effect when effect is absent', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'missing_effect')).toBe(true);
    }
  });
});

describe('validatePolicyRuleBody — effect shape', () => {
  it('reports missing_effect_action when action is missing', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 1 },
      effect: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('missing_effect_action');
    }
  });

  it('reports unknown_effect_action when action is not in allowed set', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 1 },
      effect: { action: 'self-destruct' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('unknown_effect_action');
    }
  });

  it('accepts all five allowed actions', () => {
    const actions = ['allow', 'block', 'require_dual_approval', 'warn', 'log'];
    for (const action of actions) {
      const result = validatePolicyRuleBody({
        predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 1 },
        effect: { action },
      });
      expect(result.ok).toBe(true);
    }
  });
});

describe('validatePolicyRuleBody — predicate kinds', () => {
  it('reports missing_predicate_kind when kind is absent', () => {
    const result = validatePolicyRuleBody({
      predicate: { field: 'a', op: 'eq', value: 1 },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('missing_predicate_kind');
    }
  });

  it('reports unknown_predicate_kind for unsupported kinds', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'mystery' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('unknown_predicate_kind');
    }
  });

  it('reports missing_predicate_kind when and.predicates is not an array', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'and', predicates: 'not-an-array' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('missing_predicate_kind');
    }
  });
});

describe('validatePolicyRuleBody — leaf shape', () => {
  it('reports missing_leaf_field when field is absent', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', op: 'eq', value: 1 },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'missing_leaf_field')).toBe(true);
    }
  });

  it('reports missing_leaf_op when op is absent', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', value: 1 },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'missing_leaf_op')).toBe(true);
    }
  });

  it('reports unknown_leaf_op for unsupported operator', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'fuzzy_match', value: 1 },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'unknown_leaf_op')).toBe(true);
    }
  });

  it('reports missing_leaf_value when value is undefined', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'missing_leaf_value')).toBe(true);
    }
  });

  it('accepts value=false and value=0 (not undefined)', () => {
    const r1 = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq', value: false },
      effect: { action: 'block' },
    });
    const r2 = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'eq', value: 0 },
      effect: { action: 'block' },
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('reports in_value_not_array when in/not_in value is not an array', () => {
    const r1 = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'in', value: 'not-array' },
      effect: { action: 'block' },
    });
    const r2 = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'not_in', value: 1 },
      effect: { action: 'block' },
    });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.errors.some((e) => e.code === 'in_value_not_array')).toBe(true);
    }
  });
});

describe('validatePolicyRuleBody — bounds', () => {
  it('reports predicate_too_deep when nesting exceeds limit', () => {
    let pred: unknown = { kind: 'leaf', field: 'a', op: 'eq', value: 1 };
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 5; i += 1) {
      pred = { kind: 'and', predicates: [pred] };
    }
    const result = validatePolicyRuleBody({
      predicate: pred,
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'predicate_too_deep')).toBe(true);
    }
  });
});

describe('validatePolicyRuleBody — regex', () => {
  it('reports regex_pattern_unsafe for catastrophic backtracking patterns', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'matches', value: '(a+)+$' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'regex_pattern_unsafe')).toBe(true);
    }
  });

  it('reports regex_pattern_invalid for invalid syntax', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'matches', value: '[unclosed' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'regex_pattern_invalid')).toBe(true);
    }
  });

  it('reports regex_pattern_invalid when matches.value is not a string', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'matches', value: 42 },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'regex_pattern_invalid')).toBe(true);
    }
  });

  it('accepts a safe regex pattern', () => {
    const result = validatePolicyRuleBody({
      predicate: { kind: 'leaf', field: 'a', op: 'matches', value: '^foo[0-9]+$' },
      effect: { action: 'block' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validatePolicyRuleBody — accumulation', () => {
  it('returns ALL errors, not just the first', () => {
    const result = validatePolicyRuleBody({
      // Both effect AND predicate are malformed.
      predicate: { kind: 'leaf' /* missing field, op, value */ },
      effect: { action: 'self-destruct' /* unknown */ },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // At least 4 errors: 3 leaf + 1 unknown_effect_action.
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('validatePolicyRuleBody — happy path', () => {
  it('accepts a valid policy', () => {
    const body = {
      rule_id: 'no_pii_in_messages',
      predicate: {
        kind: 'and',
        predicates: [
          { kind: 'leaf', field: 'channel', op: 'in', value: ['whatsapp', 'sms'] },
          { kind: 'leaf', field: 'message', op: 'matches', value: '^(?!.*@).*$' },
          {
            kind: 'not',
            predicate: { kind: 'leaf', field: 'risk_score', op: 'gte', value: 0.8 },
          },
        ],
      },
      effect: { action: 'block', message: 'PII detected' },
    };
    const result = validatePolicyRuleBody(body);
    expect(result.ok).toBe(true);
  });
});
