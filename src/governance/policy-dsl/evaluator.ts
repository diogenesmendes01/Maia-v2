/**
 * P9d Policy DSL — Pure, total evaluator.
 *
 * `evaluate(rule_body, context)` computes a `PolicyDecision` from a JSONB
 * `policy_rules.rule_body` payload + an arbitrary caller-supplied context.
 *
 * **Hard guarantees**:
 *  - **Pure**: no I/O, no side-effects, no `Date.now()`/`Math.random()`.
 *  - **Total**: never throws; every error path returns a `PolicyDecision`
 *    with `matched=false` and a structured `errors` entry.
 *  - **Deterministic**: identical inputs → byte-identical decisions.
 *  - **Bounded**: predicate depth ≤ `MAX_PREDICATE_DEPTH`, field paths ≤
 *    `MAX_FIELD_PATH_DEPTH`, regex inputs ≤ `MAX_REGEX_INPUT_LENGTH`.
 *  - **ReDoS-safe**: every `matches` pattern routes through the
 *    `safe-regex2`-gated cache; inputs are length-capped.
 *
 * Effects are **advisory data**: `evaluate()` returns `decision.effect` when
 * `predicate` evaluates to `true`. Enforcement (block/warn/escalate) lives
 * in the consumer (P9b Decision Engine). This separation keeps the evaluator
 * trivially auditable and lets multiple PEPs share one evaluator.
 *
 * Architecture Lock: changes to AST shape, operator semantics, or bounds
 * require founder approval. See `types.ts` and `constants.ts`.
 */

import {
  MAX_PREDICATE_DEPTH,
  MAX_REGEX_INPUT_LENGTH,
} from './constants.js';
import {
  isFieldPathTooDeep,
  resolveFieldPath,
} from './field-path.js';
import {
  compileSafeRegex,
  isPatternMarkedInvalid,
  isPatternMarkedUnsafe,
} from './regex-cache.js';
import type {
  PolicyDecision,
  PolicyEvaluationDiagnostics,
  PolicyEvaluationError,
  PolicyLeafPredicate,
  PolicyOperator,
  PolicyPredicate,
  PolicyRuleBody,
} from './types.js';

/** Mutable evaluation state threaded through recursion. */
type EvalState = {
  errors: PolicyEvaluationError[];
  diagnostics: PolicyEvaluationDiagnostics;
};

/**
 * Evaluate `rule_body` against `context`. Returns a `PolicyDecision`.
 *
 * Errors during evaluation are captured (never thrown). When `errors.length
 * > 0` the consumer should treat the policy as inert (`matched === false`)
 * and surface the codes for ops review. The evaluator's totality guarantee
 * means a malformed policy can never crash a PEP.
 */
export function evaluate(
  rule_body: PolicyRuleBody | null | undefined,
  context: unknown,
): PolicyDecision {
  const state: EvalState = {
    errors: [],
    diagnostics: {
      predicate_depth_visited: 0,
      field_lookups: 0,
      regex_cache_hits: 0,
      regex_compiled: 0,
    },
  };

  if (!rule_body || typeof rule_body !== 'object') {
    return inert(state, {
      code: 'malformed_predicate',
      message: 'rule_body is missing or not an object',
      path: '$',
    });
  }

  if (!rule_body.predicate || typeof rule_body.predicate !== 'object') {
    return inert(state, {
      code: 'malformed_predicate',
      message: 'rule_body.predicate is missing or not an object',
      path: '$.predicate',
    });
  }

  const matched = evalPredicate(rule_body.predicate, context, state, 0, '$.predicate');

  // Effect is only attached when matched and there were no evaluation errors.
  // This makes "soft fail" (errors → matched=false) trivially observable.
  const effect =
    matched && state.errors.length === 0 ? rule_body.effect : undefined;

  return {
    matched: matched && state.errors.length === 0,
    rule_id: rule_body.rule_id,
    effect,
    errors: state.errors,
    diagnostics: state.diagnostics,
  };
}

function inert(state: EvalState, error: PolicyEvaluationError): PolicyDecision {
  state.errors.push(error);
  return {
    matched: false,
    errors: state.errors,
    diagnostics: state.diagnostics,
  };
}

function evalPredicate(
  pred: PolicyPredicate,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): boolean {
  state.diagnostics.predicate_depth_visited = Math.max(
    state.diagnostics.predicate_depth_visited,
    depth,
  );

  if (depth > MAX_PREDICATE_DEPTH) {
    state.errors.push({
      code: 'predicate_depth_exceeded',
      message: `predicate depth ${depth} exceeds limit ${MAX_PREDICATE_DEPTH}`,
      path,
    });
    return false;
  }

  if (!pred || typeof pred !== 'object') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'predicate node is missing or not an object',
      path,
    });
    return false;
  }

  switch (pred.kind) {
    case 'leaf':
      return evalLeaf(pred, context, state, path);
    case 'and':
      return evalAnd(pred.predicates, context, state, depth, path);
    case 'or':
      return evalOr(pred.predicates, context, state, depth, path);
    case 'not':
      return !evalPredicate(pred.predicate, context, state, depth + 1, `${path}.not`);
    default:
      state.errors.push({
        code: 'malformed_predicate',
        message: `unknown predicate kind: ${String((pred as { kind: unknown }).kind)}`,
        path,
      });
      return false;
  }
}

function evalAnd(
  preds: PolicyPredicate[] | undefined,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): boolean {
  if (!Array.isArray(preds)) {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'and.predicates is not an array',
      path,
    });
    return false;
  }
  // Empty AND is vacuously true (matches boolean-algebra identity).
  // Short-circuit on first false to keep cost minimal.
  for (let i = 0; i < preds.length; i += 1) {
    const child = preds[i];
    if (!child) continue;
    if (!evalPredicate(child, context, state, depth + 1, `${path}.and[${i}]`)) {
      return false;
    }
  }
  return true;
}

function evalOr(
  preds: PolicyPredicate[] | undefined,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): boolean {
  if (!Array.isArray(preds)) {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'or.predicates is not an array',
      path,
    });
    return false;
  }
  // Empty OR is vacuously false (boolean-algebra identity).
  // Short-circuit on first true.
  for (let i = 0; i < preds.length; i += 1) {
    const child = preds[i];
    if (!child) continue;
    if (evalPredicate(child, context, state, depth + 1, `${path}.or[${i}]`)) {
      return true;
    }
  }
  return false;
}

function evalLeaf(
  leaf: PolicyLeafPredicate,
  context: unknown,
  state: EvalState,
  path: string,
): boolean {
  if (typeof leaf.field !== 'string') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'leaf.field is missing or not a string',
      path,
    });
    return false;
  }
  if (typeof leaf.op !== 'string') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'leaf.op is missing or not a string',
      path,
    });
    return false;
  }

  if (isFieldPathTooDeep(leaf.field)) {
    state.errors.push({
      code: 'field_path_depth_exceeded',
      message: `field path "${leaf.field}" exceeds depth limit`,
      path: `${path}.field`,
    });
    return false;
  }

  state.diagnostics.field_lookups += 1;
  const fieldValue = resolveFieldPath(context, leaf.field);
  // Note: unresolved fields are NOT errors — they simply make the leaf
  // false (consistent with the policy author's intent: "if the field is
  // missing, the predicate doesn't apply"). Only unresolvable + an op that
  // strictly requires a value would otherwise need to throw, but our op
  // semantics already return false for type-mismatched operands.
  return applyOperator(leaf.op as PolicyOperator, fieldValue, leaf.value, state, path);
}

function applyOperator(
  op: PolicyOperator,
  left: unknown,
  right: unknown,
  state: EvalState,
  path: string,
): boolean {
  switch (op) {
    case 'eq':
      return deepEqual(left, right);
    case 'neq':
      return !deepEqual(left, right);
    case 'in':
      if (!Array.isArray(right)) return false;
      return right.some((candidate) => deepEqual(left, candidate));
    case 'not_in':
      if (!Array.isArray(right)) return false;
      return !right.some((candidate) => deepEqual(left, candidate));
    case 'gt':
      return numericCompare(left, right, (a, b) => a > b);
    case 'gte':
      return numericCompare(left, right, (a, b) => a >= b);
    case 'lt':
      return numericCompare(left, right, (a, b) => a < b);
    case 'lte':
      return numericCompare(left, right, (a, b) => a <= b);
    case 'contains':
      return containsOp(left, right);
    case 'matches':
      return matchesOp(left, right, state, path);
    default:
      state.errors.push({
        code: 'malformed_predicate',
        message: `unknown operator: ${String(op)}`,
        path,
      });
      return false;
  }
}

/** Strict deep-equality. NaN is **not** equal to NaN (mirrors `===`). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Both must be of the same kind; null/undefined handled above by `===`.
  if (
    a === null ||
    b === null ||
    typeof a !== typeof b ||
    typeof a !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const akeys = Object.keys(ao).sort();
  const bkeys = Object.keys(bo).sort();
  if (akeys.length !== bkeys.length) return false;
  for (let i = 0; i < akeys.length; i += 1) {
    if (akeys[i] !== bkeys[i]) return false;
    const k = akeys[i] as string;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function numericCompare(
  left: unknown,
  right: unknown,
  cmp: (a: number, b: number) => boolean,
): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return cmp(left, right);
}

function containsOp(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.includes(right);
  }
  if (Array.isArray(left)) {
    return left.some((candidate) => deepEqual(candidate, right));
  }
  return false;
}

function matchesOp(
  left: unknown,
  right: unknown,
  state: EvalState,
  path: string,
): boolean {
  if (typeof right !== 'string') return false;
  // Only string inputs can be regex-matched. Numbers, booleans, etc. → false.
  if (typeof left !== 'string') return false;
  if (left.length > MAX_REGEX_INPUT_LENGTH) {
    state.errors.push({
      code: 'regex_input_too_long',
      message: `input length ${left.length} exceeds ${MAX_REGEX_INPUT_LENGTH}`,
      path,
    });
    return false;
  }

  // Short-circuit if the cache already knows this pattern is unsafe (so we
  // can emit the precise `regex_pattern_unsafe` code rather than the generic
  // compile-failure code).
  if (isPatternMarkedUnsafe(right)) {
    state.errors.push({
      code: 'regex_pattern_unsafe',
      message: `pattern "${right}" failed safe-regex2`,
      path,
    });
    return false;
  }

  const regex = compileSafeRegex(right);
  if (!regex) {
    // Distinguish the two failure modes so ops can triage at the right level
    // (an unsafe pattern is an authoring bug; an evaluation failure is a
    // codepath defect because the validator should have caught it earlier).
    if (isPatternMarkedUnsafe(right)) {
      state.errors.push({
        code: 'regex_pattern_unsafe',
        message: `pattern "${right}" failed safe-regex2`,
        path,
      });
    } else if (isPatternMarkedInvalid(right)) {
      state.errors.push({
        code: 'regex_evaluation_failed',
        message: `pattern "${right}" is not a valid regular expression`,
        path,
      });
    } else {
      state.errors.push({
        code: 'regex_evaluation_failed',
        message: `pattern "${right}" failed to compile`,
        path,
      });
    }
    return false;
  }
  // Diagnostics (best-effort): we can't tell from here whether this was a
  // hit or a fresh compile without inspecting the cache stats; the
  // evaluator-level diagnostics are intentionally coarse.
  try {
    return regex.test(left);
  } catch {
    state.errors.push({
      code: 'regex_evaluation_failed',
      message: `regex.test threw on input of length ${left.length}`,
      path,
    });
    return false;
  }
}
