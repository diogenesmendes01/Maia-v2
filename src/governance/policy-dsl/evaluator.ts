/**
 * P9d Policy DSL — Pure, total evaluator.
 *
 * `evaluate(rule_body, context)` computes a `PolicyDecision` from a JSONB
 * `policy_rules.rule_body` payload + an arbitrary caller-supplied context.
 *
 * **Hard guarantees**:
 *  - **Pure**: no I/O, no side-effects, no `Date.now()`/`Math.random()`.
 *  - **Total**: never throws; every error path returns a `PolicyDecision`
 *    with `outcome=evaluation_error` (or `not_applicable`) and a structured
 *    `errors` entry.
 *  - **Deterministic**: identical inputs → byte-identical decisions.
 *  - **Bounded**: predicate depth ≤ `MAX_PREDICATE_DEPTH`, field paths ≤
 *    `MAX_FIELD_PATH_DEPTH`, regex inputs ≤ `MAX_REGEX_INPUT_LENGTH`.
 *  - **ReDoS-safe**: every `matches` pattern routes through the
 *    `safe-regex2`-gated cache; inputs are length-capped.
 *  - **Fail-closed on missing context**: equality ops short-circuit to
 *    `not_applicable`; ordinal ops short-circuit to `evaluation_error`.
 *    Branch children that aren't objects produce `malformed_branch_child`
 *    and force the whole decision inert — they are never silently skipped.
 *  - **Matched decisions have valid effects**: runtime re-checks the effect
 *    shape before returning `matched=true`; missing/unknown actions emit
 *    `invalid_effect` and force `evaluation_error`.
 *
 * Tri-state outcome (`PolicyOutcome`):
 *  - `matched`: predicate true + effect valid + no errors.
 *  - `not_matched`: predicate false (all fields present, all ops clean).
 *  - `not_applicable`: equality/membership/string op hit a missing field.
 *  - `evaluation_error`: structural fault, ordinal op against missing field,
 *    malformed branch child, depth-exceeded, regex compile failure, or
 *    invalid effect.
 *
 * **Caller contract (PEPs)**: callers MUST switch on `decision.outcome`.
 * Treating `decision.matched === false` as "rule didn't apply" collapses
 * `not_applicable` and `evaluation_error` into a silent allow. Use the
 * `enforce()` helper in `enforcement.ts` for the canonical fail-closed
 * mapping (Architecture Lock).
 *
 * Effects are **advisory data**: `evaluate()` returns `decision.effect` when
 * the outcome is `matched`. Enforcement (block/warn/escalate) lives in the
 * consumer (P9b Decision Engine). This separation keeps the evaluator
 * trivially auditable and lets multiple PEPs share one evaluator.
 *
 * Architecture Lock: changes to AST shape, operator semantics, outcome
 * enum, or bounds require founder approval. See `types.ts` and `constants.ts`.
 */

import {
  ALLOWED_EFFECT_ACTIONS,
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

const ALLOWED_EFFECTS_SET = new Set<string>(ALLOWED_EFFECT_ACTIONS);

/**
 * Leaf result tri-state. The evaluator propagates this through the boolean
 * tree so we can surface `not_applicable` vs `not_matched` at the top.
 *
 *  - `true`   — leaf matched cleanly.
 *  - `false`  — leaf evaluated cleanly and did not match.
 *  - `na`     — required field was absent for an equality-style operator;
 *    the leaf has no defined truth value.
 *  - `err`    — an evaluation error was recorded; the whole decision is inert.
 */
type LeafTriState = true | false | 'na' | 'err';

/** Mutable evaluation state threaded through recursion. */
type EvalState = {
  errors: PolicyEvaluationError[];
  diagnostics: PolicyEvaluationDiagnostics;
};

/**
 * Evaluate `rule_body` against `context`. Returns a `PolicyDecision`.
 *
 * Errors during evaluation are captured (never thrown). The decision's
 * `outcome` field is the load-bearing discriminator:
 *
 *  - `matched`: predicate true + effect valid + zero errors.
 *  - `not_matched`: predicate false, all fields present, no errors.
 *  - `not_applicable`: an equality/membership/string op needed a field that
 *    was absent — author intent ("rule applies when field has this value")
 *    has no defined answer.
 *  - `evaluation_error`: ordinal op against missing field, malformed runtime
 *    body, depth/length-exceeded, regex compile failure, invalid effect.
 *    **PEPs MUST treat this as BLOCK**.
 *
 * The evaluator's totality guarantee means a malformed policy can never
 * crash a PEP — but it CAN force `evaluation_error`, which PEPs MUST
 * fail-closed on. See `enforcement.ts` for the canonical helper.
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

  const leafResult = evalPredicate(
    rule_body.predicate,
    context,
    state,
    0,
    '$.predicate',
  );

  // Any recorded error forces evaluation_error regardless of the boolean.
  if (state.errors.length > 0 || leafResult === 'err') {
    return {
      outcome: 'evaluation_error',
      matched: false,
      rule_id: rule_body.rule_id,
      errors: state.errors,
      diagnostics: state.diagnostics,
    };
  }

  if (leafResult === 'na') {
    return {
      outcome: 'not_applicable',
      matched: false,
      rule_id: rule_body.rule_id,
      errors: state.errors,
      diagnostics: state.diagnostics,
    };
  }

  if (leafResult === false) {
    return {
      outcome: 'not_matched',
      matched: false,
      rule_id: rule_body.rule_id,
      errors: state.errors,
      diagnostics: state.diagnostics,
    };
  }

  // leafResult === true → matched. Re-validate effect before returning it.
  // Architecture Lock: a matched decision MUST carry an enforceable effect.
  // Validator catches this at proposal time, but DB corruption or schema
  // drift could let an invalid effect through; we re-check defensively.
  const effect = rule_body.effect;
  const effectValid =
    effect &&
    typeof effect === 'object' &&
    typeof (effect as { action?: unknown }).action === 'string' &&
    ALLOWED_EFFECTS_SET.has((effect as { action: string }).action);

  if (!effectValid) {
    const action = (effect as { action?: unknown } | undefined)?.action;
    state.errors.push({
      code: 'invalid_effect',
      message:
        effect === undefined || effect === null
          ? 'matched decision has missing effect'
          : `matched decision has invalid effect.action: ${String(action)}`,
      path: '$.effect',
    });
    return {
      outcome: 'evaluation_error',
      matched: false,
      rule_id: rule_body.rule_id,
      errors: state.errors,
      diagnostics: state.diagnostics,
    };
  }

  return {
    outcome: 'matched',
    matched: true,
    rule_id: rule_body.rule_id,
    effect,
    errors: state.errors,
    diagnostics: state.diagnostics,
  };
}

function inert(state: EvalState, error: PolicyEvaluationError): PolicyDecision {
  state.errors.push(error);
  return {
    outcome: 'evaluation_error',
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
): LeafTriState {
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
    return 'err';
  }

  if (!pred || typeof pred !== 'object') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'predicate node is missing or not an object',
      path,
    });
    return 'err';
  }

  switch (pred.kind) {
    case 'leaf':
      return evalLeaf(pred, context, state, path);
    case 'and':
      return evalAnd(pred.predicates, context, state, depth, path);
    case 'or':
      return evalOr(pred.predicates, context, state, depth, path);
    case 'not':
      return evalNot(pred.predicate, context, state, depth, path);
    default:
      state.errors.push({
        code: 'malformed_predicate',
        message: `unknown predicate kind: ${String((pred as { kind: unknown }).kind)}`,
        path,
      });
      return 'err';
  }
}

/**
 * AND fold over tri-state children.
 *
 * Truth table (left × right):
 *   true  &&  true   = true
 *   true  &&  false  = false   (short-circuit on first false)
 *   any   &&  err    = err
 *   any   &&  na     = na      (cannot answer AND if one side is N/A,
 *                                unless we already saw a false → short-circuit)
 *   false &&  any    = false
 *
 * Note: `not_applicable` is "absorbed" by `false` (a definite false stays
 * false even alongside an N/A) but otherwise propagates upward — an AND
 * with a clean true and an N/A is N/A, mirroring three-valued (Kleene) logic.
 */
function evalAnd(
  preds: PolicyPredicate[] | undefined,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): LeafTriState {
  if (!Array.isArray(preds)) {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'and.predicates is not an array',
      path,
    });
    return 'err';
  }
  // Empty AND is vacuously true (matches boolean-algebra identity).
  let sawNotApplicable = false;
  for (let i = 0; i < preds.length; i += 1) {
    const child = preds[i];
    // Per Codex review: do NOT silently skip null/undefined children. A
    // corrupted `{kind:'and', predicates:[null]}` body would otherwise
    // evaluate to vacuously true and bypass governance.
    if (child === null || child === undefined || typeof child !== 'object') {
      state.errors.push({
        code: 'malformed_branch_child',
        message: `and.predicates[${i}] is not a predicate object`,
        path: `${path}.and[${i}]`,
      });
      return 'err';
    }
    const r = evalPredicate(child, context, state, depth + 1, `${path}.and[${i}]`);
    if (r === 'err') return 'err';
    if (r === false) return false;
    if (r === 'na') sawNotApplicable = true;
    // r === true → continue scanning.
  }
  return sawNotApplicable ? 'na' : true;
}

/**
 * OR fold over tri-state children. Dual of `evalAnd`.
 *
 * Truth table:
 *   true  ||  any    = true    (short-circuit on first true)
 *   false ||  false  = false
 *   any   ||  err    = err
 *   false ||  na     = na      (cannot answer OR if all defined sides are
 *                                false and at least one is N/A)
 */
function evalOr(
  preds: PolicyPredicate[] | undefined,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): LeafTriState {
  if (!Array.isArray(preds)) {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'or.predicates is not an array',
      path,
    });
    return 'err';
  }
  // Empty OR is vacuously false (boolean-algebra identity).
  let sawNotApplicable = false;
  for (let i = 0; i < preds.length; i += 1) {
    const child = preds[i];
    if (child === null || child === undefined || typeof child !== 'object') {
      state.errors.push({
        code: 'malformed_branch_child',
        message: `or.predicates[${i}] is not a predicate object`,
        path: `${path}.or[${i}]`,
      });
      return 'err';
    }
    const r = evalPredicate(child, context, state, depth + 1, `${path}.or[${i}]`);
    if (r === 'err') return 'err';
    if (r === true) return true;
    if (r === 'na') sawNotApplicable = true;
    // r === false → continue scanning.
  }
  return sawNotApplicable ? 'na' : false;
}

/**
 * NOT inversion preserves `not_applicable`/`err`. Inverting `not_applicable`
 * to `matched=true` would be unsound — "the field is missing so the policy
 * applies" is the exact failure mode that lets exclusion-style rules
 * (`not_in ['banned']`) silently match.
 */
function evalNot(
  inner: PolicyPredicate,
  context: unknown,
  state: EvalState,
  depth: number,
  path: string,
): LeafTriState {
  if (!inner || typeof inner !== 'object') {
    state.errors.push({
      code: 'malformed_branch_child',
      message: 'not.predicate is missing or not an object',
      path: `${path}.not`,
    });
    return 'err';
  }
  const r = evalPredicate(inner, context, state, depth + 1, `${path}.not`);
  if (r === 'err' || r === 'na') return r;
  return !r as LeafTriState;
}

function evalLeaf(
  leaf: PolicyLeafPredicate,
  context: unknown,
  state: EvalState,
  path: string,
): LeafTriState {
  if (typeof leaf.field !== 'string') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'leaf.field is missing or not a string',
      path,
    });
    return 'err';
  }
  if (typeof leaf.op !== 'string') {
    state.errors.push({
      code: 'malformed_predicate',
      message: 'leaf.op is missing or not a string',
      path,
    });
    return 'err';
  }

  if (isFieldPathTooDeep(leaf.field)) {
    state.errors.push({
      code: 'field_path_depth_exceeded',
      message: `field path "${leaf.field}" exceeds depth limit`,
      path: `${path}.field`,
    });
    return 'err';
  }

  state.diagnostics.field_lookups += 1;
  const fieldValue = resolveFieldPath(context, leaf.field);
  const fieldMissing = fieldValue === undefined;

  // Per-operator missing-field policy (Architecture Lock — see types.ts).
  //
  //  - Equality / membership / string ops → `not_applicable`. Author intent
  //    ("rule applies when field has this value") cannot be answered when
  //    the field is absent. Negative predicates like `neq` or `not_in` MUST
  //    NOT silently coerce `undefined` into a match — that flipped
  //    exclusion lists into implicit allow rules (Codex review #98 critical).
  //  - Ordinal ops (`gt`/`gte`/`lt`/`lte`) → `evaluation_error: missing_field`.
  //    Numeric comparison against missing context cannot be coerced to 0
  //    without changing the rule's meaning. PEP MUST block.
  //  - `not` / `and` / `or` propagation: see `evalNot`/`evalAnd`/`evalOr`.
  if (fieldMissing) {
    switch (leaf.op as PolicyOperator) {
      case 'eq':
      case 'neq':
      case 'in':
      case 'not_in':
      case 'contains':
      case 'matches':
        return 'na';
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        state.errors.push({
          code: 'missing_field',
          message: `ordinal op "${leaf.op}" requires a numeric value at "${leaf.field}" (got undefined)`,
          path: `${path}.field`,
        });
        return 'err';
      default:
        // Unknown op falls through to `applyOperator` which will record
        // `malformed_predicate`.
        break;
    }
  }

  return applyOperator(leaf.op as PolicyOperator, fieldValue, leaf.value, state, path);
}

function applyOperator(
  op: PolicyOperator,
  left: unknown,
  right: unknown,
  state: EvalState,
  path: string,
): LeafTriState {
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
      return 'err';
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
): LeafTriState {
  if (typeof right !== 'string') return false;
  // Only string inputs can be regex-matched. Numbers, booleans, etc. → false.
  if (typeof left !== 'string') return false;
  if (left.length > MAX_REGEX_INPUT_LENGTH) {
    state.errors.push({
      code: 'regex_input_too_long',
      message: `input length ${left.length} exceeds ${MAX_REGEX_INPUT_LENGTH}`,
      path,
    });
    return 'err';
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
    return 'err';
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
    return 'err';
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
    return 'err';
  }
}
