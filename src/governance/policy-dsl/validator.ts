/**
 * P9d Policy DSL — Proposal-time validator.
 *
 * `validatePolicyRuleBody(body, options?)` is invoked **before** a
 * `policy_rules` row is allowed to leave `status='proposed'`. It catches
 * every malformed shape the evaluator would have to handle at runtime.
 *
 * Why a separate validator?
 *  - **Keeps evaluator hot path lean**: production evaluations run on
 *    pre-validated bodies. The defensive checks in the evaluator are a
 *    safety net (in case of corrupted JSONB or schema migration bugs),
 *    not the primary gate.
 *  - **Surfaces operator/regex problems at proposal time**: a policy author
 *    sees `regex_pattern_unsafe` when they propose, not at runtime when a
 *    user request gets quietly dropped to `evaluation_error`.
 *  - **Enforces depth + array-shape constraints up-front**: bounded depth
 *    + bounded fan-out + bounded total nodes means CI can statically check
 *    that no policy can burn unbounded CPU.
 *  - **Optional field-path allowlist** (`options.allowedFieldPaths`): when
 *    the caller knows which fields its `EvaluationContext` will surface
 *    (P9b's Early/Mid/Late shapes), it can pass the allowlist here and any
 *    `leaf.field` outside that set is rejected with `unknown_field_path`.
 *    The default is permissive for backwards-compat.
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
  MAX_BRANCH_FANOUT,
  MAX_LITERAL_ARRAY,
  MAX_LITERAL_STRING,
  MAX_PREDICATE_DEPTH,
  MAX_REGEX_PATTERN,
  MAX_TOTAL_PREDICATE_NODES,
} from './constants.js';
import {
  isFieldPathTooDeep,
  splitFieldPath,
} from './field-path.js';
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
 * Options accepted by `validatePolicyRuleBody`. All optional.
 *
 *  - `allowedFieldPaths`: when provided, leaf `field` paths NOT in this set
 *    are rejected with `unknown_field_path`. P9b's Decision Engine will
 *    pass the union of fields its Early/Mid/Late EvaluationContexts expose.
 *    Default is permissive (unset → any path passes the shape checks).
 *    This is the Architecture Lock that prevents a policy author from
 *    targeting a field that no PEP will ever populate (which would
 *    otherwise quietly evaluate to `not_applicable` forever).
 */
export type ValidatePolicyOptions = {
  allowedFieldPaths?: ReadonlySet<string>;
};

type ValidationState = {
  errors: PolicyValidationError[];
  /** Running total of predicate nodes seen so far. */
  nodeCount: number;
  /** Caller-provided allowlist (or undefined → permissive). */
  allowedFieldPaths: ReadonlySet<string> | undefined;
  /** Tripped once total nodes exceed `MAX_TOTAL_PREDICATE_NODES`. */
  totalNodesExceeded: boolean;
};

/**
 * Validate a `policy_rules.rule_body` payload. Pure + total — never throws.
 *
 * The validator is **strict**: it accumulates ALL errors (not just the first
 * one) so the policy author can fix everything in a single round-trip. This
 * is intentional even though the evaluator short-circuits at the first
 * structural fault, because validation is a UX surface and evaluation is a
 * hot path with different ergonomics.
 *
 * Bounded-runtime guarantee (Codex review #98): every accepted policy MUST
 * fit within `MAX_PREDICATE_DEPTH`, `MAX_BRANCH_FANOUT`, AND
 * `MAX_TOTAL_PREDICATE_NODES` — the validator enforces all three so the
 * evaluator can never spend more than the documented per-evaluation budget
 * on a valid input.
 */
export function validatePolicyRuleBody(
  body: unknown,
  options: ValidatePolicyOptions = {},
): PolicyValidationResult {
  const state: ValidationState = {
    errors: [],
    nodeCount: 0,
    allowedFieldPaths: options.allowedFieldPaths,
    totalNodesExceeded: false,
  };

  if (!body || typeof body !== 'object') {
    state.errors.push({
      code: 'missing_predicate',
      message: 'rule_body is missing or not an object',
      path: '$',
    });
    return { ok: false, errors: state.errors };
  }
  const b = body as Partial<PolicyRuleBody>;
  if (!b.predicate || typeof b.predicate !== 'object') {
    state.errors.push({
      code: 'missing_predicate',
      message: 'rule_body.predicate is missing or not an object',
      path: '$.predicate',
    });
  } else {
    validatePredicate(b.predicate as PolicyPredicate, '$.predicate', 0, state);
  }

  if (!b.effect || typeof b.effect !== 'object') {
    state.errors.push({
      code: 'missing_effect',
      message: 'rule_body.effect is missing or not an object',
      path: '$.effect',
    });
  } else {
    validateEffect(b.effect, '$.effect', state.errors);
  }

  return state.errors.length === 0 ? { ok: true } : { ok: false, errors: state.errors };
}

function validatePredicate(
  pred: PolicyPredicate | undefined,
  path: string,
  depth: number,
  state: ValidationState,
): void {
  if (!pred || typeof pred !== 'object') {
    state.errors.push({
      code: 'missing_predicate_kind',
      message: 'predicate node is missing',
      path,
    });
    return;
  }
  if (depth > MAX_PREDICATE_DEPTH) {
    state.errors.push({
      code: 'predicate_too_deep',
      message: `predicate depth ${depth} exceeds limit ${MAX_PREDICATE_DEPTH}`,
      path,
    });
    return;
  }

  // Bounded-runtime guarantee: every visited node counts against the
  // total-nodes cap (Codex review #98 fixed: previously unbounded).
  state.nodeCount += 1;
  if (state.nodeCount > MAX_TOTAL_PREDICATE_NODES) {
    if (!state.totalNodesExceeded) {
      state.totalNodesExceeded = true;
      state.errors.push({
        code: 'predicate_too_deep',
        message: `total predicate nodes exceeds limit ${MAX_TOTAL_PREDICATE_NODES}`,
        path,
      });
    }
    return;
  }

  const kind = (pred as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    state.errors.push({
      code: 'missing_predicate_kind',
      message: 'predicate.kind is missing or not a string',
      path: `${path}.kind`,
    });
    return;
  }
  if (!ALLOWED_PREDICATE_KINDS_SET.has(kind)) {
    state.errors.push({
      code: 'unknown_predicate_kind',
      message: `unknown predicate kind: ${kind}`,
      path: `${path}.kind`,
    });
    return;
  }

  switch (kind) {
    case 'leaf':
      validateLeaf(pred as PolicyPredicate & { kind: 'leaf' }, path, state);
      return;
    case 'and':
    case 'or': {
      const branch = pred as PolicyPredicate & { predicates?: unknown };
      if (!Array.isArray(branch.predicates)) {
        state.errors.push({
          code: 'missing_predicate_kind',
          message: `${kind}.predicates is missing or not an array`,
          path: `${path}.predicates`,
        });
        return;
      }
      if (branch.predicates.length > MAX_BRANCH_FANOUT) {
        // Bounded fan-out — Codex review #98 fix. Without this, a single
        // OR with 10k children passes validation and burns CPU at runtime.
        state.errors.push({
          code: 'predicate_too_deep',
          message: `${kind}.predicates length ${branch.predicates.length} exceeds fan-out limit ${MAX_BRANCH_FANOUT}`,
          path: `${path}.predicates`,
        });
        return;
      }
      branch.predicates.forEach((child, idx) => {
        if (child === null || child === undefined || typeof child !== 'object') {
          // Codex review #98 fix: branch children MUST be objects. The old
          // evaluator silently skipped null/undefined; the validator now
          // rejects them at proposal time so corrupted JSONB can't slip
          // through.
          state.errors.push({
            code: 'missing_predicate_kind',
            message: `${kind}.predicates[${idx}] is not a predicate object`,
            path: `${path}.${kind}[${idx}]`,
          });
          return;
        }
        validatePredicate(
          child as PolicyPredicate,
          `${path}.${kind}[${idx}]`,
          depth + 1,
          state,
        );
      });
      return;
    }
    case 'not': {
      const branch = pred as PolicyPredicate & { predicate?: unknown };
      if (!branch.predicate || typeof branch.predicate !== 'object') {
        state.errors.push({
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
        state,
      );
      return;
    }
    default:
      // Unreachable thanks to ALLOWED_PREDICATE_KINDS_SET check above.
      state.errors.push({
        code: 'unknown_predicate_kind',
        message: `unknown predicate kind: ${kind}`,
        path: `${path}.kind`,
      });
  }
}

function validateLeaf(
  leaf: { kind: 'leaf'; field?: unknown; op?: unknown; value?: unknown },
  path: string,
  state: ValidationState,
): void {
  // Validator is intentionally **non-short-circuit**: it accumulates ALL
  // shape errors for the leaf so the policy author sees the full picture in
  // a single round-trip. The evaluator (hot path) does short-circuit.
  let validField = false;
  if (typeof leaf.field !== 'string' || leaf.field.length === 0) {
    state.errors.push({
      code: 'missing_leaf_field',
      message: 'leaf.field is missing or not a non-empty string',
      path: `${path}.field`,
    });
  } else if (isFieldPathTooDeep(leaf.field)) {
    // Defensive — depth is structural, not just a runtime hazard.
    state.errors.push({
      code: 'missing_leaf_field',
      message: `leaf.field "${leaf.field}" exceeds field-path depth limit`,
      path: `${path}.field`,
    });
  } else if (splitFieldPath(leaf.field).some((seg) => seg.length === 0)) {
    // Empty segments (`"a..b"`) are unresolvable at evaluation time. Catch
    // at proposal so authors don't ship dead rules.
    state.errors.push({
      code: 'missing_leaf_field',
      message: `leaf.field "${leaf.field}" contains an empty path segment`,
      path: `${path}.field`,
    });
  } else {
    validField = true;
  }

  // Allowlist check (Codex review #98 — `unknown_field_path`).
  // Only runs when the caller passed `options.allowedFieldPaths` AND the
  // field is structurally valid. P9b will pass the union of Early/Mid/Late
  // EvaluationContext keys here; default callers (tests, ad-hoc validation)
  // get permissive behaviour to keep the public surface stable.
  if (
    validField &&
    state.allowedFieldPaths !== undefined &&
    !state.allowedFieldPaths.has(leaf.field as string)
  ) {
    state.errors.push({
      code: 'unknown_field_path',
      message: `leaf.field "${leaf.field as string}" is not declared in the EvaluationContext allowlist`,
      path: `${path}.field`,
    });
  }

  let op: PolicyOperator | null = null;
  if (typeof leaf.op !== 'string') {
    state.errors.push({
      code: 'missing_leaf_op',
      message: 'leaf.op is missing or not a string',
      path: `${path}.op`,
    });
  } else if (!ALLOWED_OPERATORS_SET.has(leaf.op)) {
    state.errors.push({
      code: 'unknown_leaf_op',
      message: `unknown operator: ${leaf.op}`,
      path: `${path}.op`,
    });
  } else {
    op = leaf.op as PolicyOperator;
  }

  // `value` may be `false` or `0` so check for `undefined` specifically.
  if (leaf.value === undefined) {
    state.errors.push({
      code: 'missing_leaf_value',
      message: 'leaf.value is missing',
      path: `${path}.value`,
    });
    return;
  }

  // Op-specific value-shape checks only run when we know the op.
  if (op === null) return;
  if ((op === 'in' || op === 'not_in') && !Array.isArray(leaf.value)) {
    state.errors.push({
      code: 'in_value_not_array',
      message: `${op}.value must be an array`,
      path: `${path}.value`,
    });
  }

  // --- Literal-size limits (round-2 review) ---
  // These caps bound worst-case evaluation CPU regardless of context.
  if ((op === 'in' || op === 'not_in') && Array.isArray(leaf.value)) {
    if (leaf.value.length > MAX_LITERAL_ARRAY) {
      state.errors.push({
        code: 'literal_too_large',
        message: `${op}.value array length ${leaf.value.length} exceeds limit ${MAX_LITERAL_ARRAY}`,
        path: `${path}.value`,
      });
    }
  }

  if (typeof leaf.value === 'string' && op !== 'matches') {
    if (leaf.value.length > MAX_LITERAL_STRING) {
      state.errors.push({
        code: 'literal_too_large',
        message: `leaf.value string length ${leaf.value.length} exceeds limit ${MAX_LITERAL_STRING}`,
        path: `${path}.value`,
      });
    }
  }

  if (op === 'matches') {
    if (typeof leaf.value !== 'string') {
      state.errors.push({
        code: 'regex_pattern_invalid',
        message: 'matches.value must be a string regex pattern',
        path: `${path}.value`,
      });
      return;
    }
    // Pattern length cap — very long patterns consume parse time and cache
    // memory disproportionately even when otherwise valid.
    if (leaf.value.length > MAX_REGEX_PATTERN) {
      state.errors.push({
        code: 'literal_too_large',
        message: `matches.value pattern length ${leaf.value.length} exceeds limit ${MAX_REGEX_PATTERN}`,
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
      state.errors.push({
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
