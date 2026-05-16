/**
 * P9d Policy DSL — Proposal-time validator.
 *
 * `validatePolicyRuleBody(body)` is invoked **before** a `policy_rules` row
 * is allowed to leave `status='proposed'`. It catches every malformed
 * shape the evaluator would have to handle at runtime.
 *
 * Why a separate validator?
 *  - **Keeps evaluator hot path lean**: production evaluations run on
 *    pre-validated bodies. The defensive checks in the evaluator are a
 *    safety net (in case of corrupted JSONB or schema migration bugs),
 *    not the primary gate.
 *  - **Surfaces operator/regex problems at proposal time**: a policy author
 *    sees `regex_pattern_unsafe` when they propose, not at runtime when a
 *    user request gets quietly dropped to `matched=false`.
 *  - **Enforces depth + array-shape constraints up-front**: bounded depth
 *    means CI can statically check generated rules.
 *
 * The validator returns a structured `PolicyValidationResult` with one
 * `errors` entry per problem, each carrying a stable `code` + JSON Pointer
 * style `path`. Codes never overlap with `PolicyEvaluationErrorCode` — the
 * two enums are separate Architecture-Lock concepts.
 */

import {
  ALLOWED_EFFECT_ACTIONS,
  ALLOWED_OPERATORS,
  ALLOWED_PREDICATE_KINDS,
  MAX_PREDICATE_DEPTH,
} from './constants.js';
import {
  compileSafeRegex,
  isPatternMarkedInvalid,
  isPatternMarkedUnsafe,
} from './regex-cache.js';
import type {
  PolicyEffectAction,
  PolicyOperator,
  PolicyPredicate,
  PolicyRuleBody,
  PolicyValidationError,
  PolicyValidationResult,
} from './types.js';

const ALLOWED_OPERATORS_SET = new Set<string>(ALLOWED_OPERATORS);
const ALLOWED_EFFECTS_SET = new Set<string>(ALLOWED_EFFECT_ACTIONS);
const ALLOWED_PREDICATE_KINDS_SET = new Set<string>(ALLOWED_PREDICATE_KINDS);

/**
 * Validate a `policy_rules.rule_body` payload. Pure + total — never throws.
 *
 * The validator is **strict**: it accumulates ALL errors (not just the first
 * one) so the policy author can fix everything in a single round-trip. This
 * is intentional even though the evaluator short-circuits at the first
 * structural fault, because validation is a UX surface and evaluation is a
 * hot path with different ergonomics.
 */
export function validatePolicyRuleBody(
  body: unknown,
): PolicyValidationResult {
  const errors: PolicyValidationError[] = [];
  if (!body || typeof body !== 'object') {
    errors.push({
      code: 'missing_predicate',
      message: 'rule_body is missing or not an object',
      path: '$',
    });
    return { ok: false, errors };
  }
  const b = body as Partial<PolicyRuleBody>;
  if (!b.predicate || typeof b.predicate !== 'object') {
    errors.push({
      code: 'missing_predicate',
      message: 'rule_body.predicate is missing or not an object',
      path: '$.predicate',
    });
  } else {
    validatePredicate(b.predicate as PolicyPredicate, '$.predicate', 0, errors);
  }

  if (!b.effect || typeof b.effect !== 'object') {
    errors.push({
      code: 'missing_effect',
      message: 'rule_body.effect is missing or not an object',
      path: '$.effect',
    });
  } else {
    validateEffect(b.effect, '$.effect', errors);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validatePredicate(
  pred: PolicyPredicate | undefined,
  path: string,
  depth: number,
  errors: PolicyValidationError[],
): void {
  if (!pred || typeof pred !== 'object') {
    errors.push({
      code: 'missing_predicate_kind',
      message: 'predicate node is missing',
      path,
    });
    return;
  }
  if (depth > MAX_PREDICATE_DEPTH) {
    errors.push({
      code: 'predicate_too_deep',
      message: `predicate depth ${depth} exceeds limit ${MAX_PREDICATE_DEPTH}`,
      path,
    });
    return;
  }

  const kind = (pred as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    errors.push({
      code: 'missing_predicate_kind',
      message: 'predicate.kind is missing or not a string',
      path: `${path}.kind`,
    });
    return;
  }
  if (!ALLOWED_PREDICATE_KINDS_SET.has(kind)) {
    errors.push({
      code: 'unknown_predicate_kind',
      message: `unknown predicate kind: ${kind}`,
      path: `${path}.kind`,
    });
    return;
  }

  switch (kind) {
    case 'leaf':
      validateLeaf(pred as PolicyPredicate & { kind: 'leaf' }, path, errors);
      return;
    case 'and':
    case 'or': {
      const branch = pred as PolicyPredicate & { predicates?: unknown };
      if (!Array.isArray(branch.predicates)) {
        errors.push({
          code: 'missing_predicate_kind',
          message: `${kind}.predicates is missing or not an array`,
          path: `${path}.predicates`,
        });
        return;
      }
      branch.predicates.forEach((child, idx) => {
        validatePredicate(
          child as PolicyPredicate,
          `${path}.${kind}[${idx}]`,
          depth + 1,
          errors,
        );
      });
      return;
    }
    case 'not': {
      const branch = pred as PolicyPredicate & { predicate?: unknown };
      if (!branch.predicate || typeof branch.predicate !== 'object') {
        errors.push({
          code: 'missing_predicate_kind',
          message: 'not.predicate is missing',
          path: `${path}.predicate`,
        });
        return;
      }
      validatePredicate(
        branch.predicate as PolicyPredicate,
        `${path}.not`,
        depth + 1,
        errors,
      );
      return;
    }
    default:
      // Unreachable thanks to ALLOWED_PREDICATE_KINDS_SET check above.
      errors.push({
        code: 'unknown_predicate_kind',
        message: `unknown predicate kind: ${kind}`,
        path: `${path}.kind`,
      });
  }
}

function validateLeaf(
  leaf: { kind: 'leaf'; field?: unknown; op?: unknown; value?: unknown },
  path: string,
  errors: PolicyValidationError[],
): void {
  // Validator is intentionally **non-short-circuit**: it accumulates ALL
  // shape errors for the leaf so the policy author sees the full picture in
  // a single round-trip. The evaluator (hot path) does short-circuit.
  if (typeof leaf.field !== 'string' || leaf.field.length === 0) {
    errors.push({
      code: 'missing_leaf_field',
      message: 'leaf.field is missing or not a non-empty string',
      path: `${path}.field`,
    });
  }

  let op: PolicyOperator | null = null;
  if (typeof leaf.op !== 'string') {
    errors.push({
      code: 'missing_leaf_op',
      message: 'leaf.op is missing or not a string',
      path: `${path}.op`,
    });
  } else if (!ALLOWED_OPERATORS_SET.has(leaf.op)) {
    errors.push({
      code: 'unknown_leaf_op',
      message: `unknown operator: ${leaf.op}`,
      path: `${path}.op`,
    });
  } else {
    op = leaf.op as PolicyOperator;
  }

  // `value` may be `false` or `0` so check for `undefined` specifically.
  if (leaf.value === undefined) {
    errors.push({
      code: 'missing_leaf_value',
      message: 'leaf.value is missing',
      path: `${path}.value`,
    });
    return;
  }

  // Op-specific value-shape checks only run when we know the op.
  if (op === null) return;
  if ((op === 'in' || op === 'not_in') && !Array.isArray(leaf.value)) {
    errors.push({
      code: 'in_value_not_array',
      message: `${op}.value must be an array`,
      path: `${path}.value`,
    });
  }

  if (op === 'matches') {
    if (typeof leaf.value !== 'string') {
      errors.push({
        code: 'regex_pattern_invalid',
        message: 'matches.value must be a string regex pattern',
        path: `${path}.value`,
      });
      return;
    }
    // First, force a compile attempt to populate the cache + detect both
    // unsafe + invalid patterns deterministically. The cache differentiates
    // 'invalid' (syntactic failure) vs 'unsafe' (parses but ReDoS-prone).
    const compiled = compileSafeRegex(leaf.value);
    if (!compiled) {
      let code: 'regex_pattern_invalid' | 'regex_pattern_unsafe';
      if (isPatternMarkedInvalid(leaf.value)) {
        code = 'regex_pattern_invalid';
      } else if (isPatternMarkedUnsafe(leaf.value)) {
        code = 'regex_pattern_unsafe';
      } else {
        // Defensive fallback — shouldn't happen because the cache always
        // marks one or the other on compile failure.
        code = 'regex_pattern_invalid';
      }
      errors.push({
        code,
        message:
          code === 'regex_pattern_unsafe'
            ? `pattern "${leaf.value}" failed safe-regex2 (catastrophic backtracking)`
            : `pattern "${leaf.value}" is not a valid regular expression`,
        path: `${path}.value`,
      });
    }
  }
}

function validateEffect(
  effect: unknown,
  path: string,
  errors: PolicyValidationError[],
): void {
  if (!effect || typeof effect !== 'object') {
    errors.push({
      code: 'missing_effect',
      message: 'effect is missing or not an object',
      path,
    });
    return;
  }
  const action = (effect as { action?: unknown }).action;
  if (typeof action !== 'string') {
    errors.push({
      code: 'missing_effect_action',
      message: 'effect.action is missing or not a string',
      path: `${path}.action`,
    });
    return;
  }
  if (!ALLOWED_EFFECTS_SET.has(action)) {
    errors.push({
      code: 'unknown_effect_action',
      message: `unknown effect.action: ${action}`,
      path: `${path}.action`,
    });
  }
  // The `effect.action` type-cast helps the consumer; not strictly needed.
  void (action as PolicyEffectAction);
}
