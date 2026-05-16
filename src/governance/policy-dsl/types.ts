/**
 * P9d Policy DSL — Type definitions.
 *
 * This module defines the **immutable AST shape** of a `policy_rules.rule_body`
 * payload. Architecture Lock (master spec §0.1): the shape of
 * `PolicyPredicate`, `PolicyEffect` and `PolicyRuleBody` requires founder
 * approval to change. Adding new operators is also locked: each operator
 * carries explicit semantics, totality guarantees, and ReDoS-safety
 * constraints documented next to its case in `evaluator.ts`.
 *
 * The DSL is intentionally limited:
 *  - **No loops, no external calls, no I/O** — `evaluate()` is pure and
 *    deterministic, side-effect-free.
 *  - **10 leaf operators** (`eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`,
 *    `lte`, `contains`, `matches`).
 *  - **3 boolean connectives** (`AND`, `OR`, `NOT`).
 *  - **Depth-bounded** (max 16) — guarantees `evaluate()` is total.
 *  - **ReDoS-safe** — every `matches` pattern is validated by `safe-regex2`
 *    at proposal time *and* enforced by an input-length cap at evaluation.
 *
 * Why this lock matters: a `policy_rules` row activated under one AST shape
 * must remain evaluable as the codebase evolves. Adding a new operator that
 * could throw, recurse, or call out to I/O would silently invalidate every
 * previously-activated policy and break governance auditability.
 */

/** Field path segment. Strings index objects; numbers index arrays. */
export type PolicyPathSegment = string | number;

/**
 * Leaf predicate — compares a value at `field` against `value` using `op`.
 *
 * - `field` is a dot-delimited path (e.g. `"transaction.amount"`).
 *   Parser splits on `.` and numeric segments index arrays.
 * - `op` selects the comparator. Type-coercion is **strict**: comparing
 *   incompatible types returns `false` deterministically (never throws).
 * - For `in` / `not_in`, `value` must be an array; otherwise the predicate
 *   evaluates to `false`.
 * - For `matches`, `value` must be a string that passed `safe-regex2`
 *   validation. Inputs longer than `MAX_REGEX_INPUT_LENGTH` (4096) are
 *   rejected (predicate yields `false`). The compiled `RegExp` is cached
 *   via an LRU bounded by `REGEX_CACHE_MAX`.
 */
export type PolicyLeafPredicate = {
  kind: 'leaf';
  field: string;
  op: PolicyOperator;
  value: PolicyComparableValue;
};

/** AND/OR/NOT branch — bounded recursion (depth ≤ MAX_PREDICATE_DEPTH). */
export type PolicyAndPredicate = {
  kind: 'and';
  predicates: PolicyPredicate[];
};

export type PolicyOrPredicate = {
  kind: 'or';
  predicates: PolicyPredicate[];
};

export type PolicyNotPredicate = {
  kind: 'not';
  predicate: PolicyPredicate;
};

/** Boolean tree node. */
export type PolicyPredicate =
  | PolicyLeafPredicate
  | PolicyAndPredicate
  | PolicyOrPredicate
  | PolicyNotPredicate;

/**
 * Operator vocabulary — exhaustively enumerated. Adding an operator requires
 * a founder-approved Architecture Lock change because it changes the
 * semantics of every existing activated `policy_rules` row.
 *
 *  - `eq` / `neq`: strict equality (`===` for primitives, deep-equal for
 *    arrays/objects). NaN never equals NaN (mirrors `===` semantics).
 *  - `in` / `not_in`: membership in an array literal.
 *  - `gt` / `gte` / `lt` / `lte`: numeric comparison. Non-numeric operands
 *    yield `false` (never throw).
 *  - `contains`: substring (string×string) or membership (array×any).
 *    Anything else → `false`.
 *  - `matches`: RegExp test, ReDoS-validated and length-capped.
 */
export type PolicyOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'matches';

/** Values that may appear in a leaf predicate `value` slot. */
export type PolicyComparableValue =
  | string
  | number
  | boolean
  | null
  | PolicyComparableValue[]
  | { [key: string]: PolicyComparableValue };

/**
 * Effect — the action the PEP must take if the predicate evaluates to `true`.
 * Effects are advisory: the evaluator returns `decision.effects` as data;
 * enforcement lives in the consumer (P9b Decision Engine).
 */
export type PolicyEffectAction =
  | 'allow'
  | 'block'
  | 'require_dual_approval'
  | 'warn'
  | 'log';

export type PolicyEffect = {
  action: PolicyEffectAction;
  /** Human-readable message. Surfaces in decision trace + audit logs. */
  message?: string;
  /** Free-form metadata for the consumer (e.g. `{ severity: "high" }`). */
  metadata?: Record<string, unknown>;
};

/**
 * The full rule body stored in `policy_rules.rule_body` (JSONB).
 * The evaluator treats this as the immutable input to `evaluate()`.
 */
export type PolicyRuleBody = {
  /** Optional human-readable name (echoed in `PolicyDecision.rule_id`). */
  rule_id?: string;
  /** Boolean tree. */
  predicate: PolicyPredicate;
  /** Applied when `predicate` evaluates to `true`. */
  effect: PolicyEffect;
};

/**
 * Result of `evaluate()`. The evaluator never throws — every error is
 * captured as a `PolicyDecision.errors` entry and `matched` is set to
 * `false` so the consumer treats the policy as inert.
 */
export type PolicyDecision = {
  /** `true` iff `predicate` evaluated to `true` (with no errors). */
  matched: boolean;
  /** Mirrors `rule_body.rule_id` when present. */
  rule_id?: string;
  /** Applied effect (only when `matched === true`). */
  effect?: PolicyEffect;
  /** Captured non-fatal evaluator errors (depth, ReDoS, bad shape, etc.). */
  errors: PolicyEvaluationError[];
  /** Diagnostic counters (predicate depth visited, regex cache hits). */
  diagnostics: PolicyEvaluationDiagnostics;
};

/** Diagnostic counters reported in every decision (for observability). */
export type PolicyEvaluationDiagnostics = {
  predicate_depth_visited: number;
  field_lookups: number;
  regex_cache_hits: number;
  regex_compiled: number;
};

/**
 * Non-fatal evaluator error. Each has a stable `code` so the consumer can
 * trace causes deterministically. The 14 codes used by the validator
 * (`validatePolicyRuleBody`) extend this set with shape-only errors.
 */
export type PolicyEvaluationError = {
  code: PolicyEvaluationErrorCode;
  message: string;
  /** Predicate path where the error surfaced (e.g. `"and[0].leaf.matches"`). */
  path?: string;
};

export type PolicyEvaluationErrorCode =
  /** Predicate tree deeper than `MAX_PREDICATE_DEPTH`. */
  | 'predicate_depth_exceeded'
  /** Leaf `field` path exceeds `MAX_FIELD_PATH_DEPTH`. */
  | 'field_path_depth_exceeded'
  /** Leaf `field` cannot be resolved (returns `undefined`). */
  | 'field_path_unresolvable'
  /** `matches` input string exceeds `MAX_REGEX_INPUT_LENGTH`. */
  | 'regex_input_too_long'
  /** `matches` pattern failed `safe-regex2` (proposal-time validator). */
  | 'regex_pattern_unsafe'
  /** Compiled `RegExp` threw at evaluation (defensive — should never happen). */
  | 'regex_evaluation_failed'
  /** Generic guard for malformed inputs reaching the evaluator at runtime. */
  | 'malformed_predicate';

/**
 * Validator error code (proposal-time `validatePolicyRuleBody`). Distinct
 * from `PolicyEvaluationErrorCode` to keep evaluation-vs-validation cleanly
 * separated; the evaluator never produces validator codes and vice-versa.
 */
export type PolicyValidationErrorCode =
  | 'missing_predicate'
  | 'missing_effect'
  | 'missing_effect_action'
  | 'unknown_effect_action'
  | 'missing_predicate_kind'
  | 'unknown_predicate_kind'
  | 'missing_leaf_field'
  | 'missing_leaf_op'
  | 'unknown_leaf_op'
  | 'missing_leaf_value'
  | 'in_value_not_array'
  | 'predicate_too_deep'
  | 'regex_pattern_invalid'
  | 'regex_pattern_unsafe';

export type PolicyValidationError = {
  code: PolicyValidationErrorCode;
  message: string;
  path: string;
};

export type PolicyValidationResult =
  | { ok: true }
  | { ok: false; errors: PolicyValidationError[] };
