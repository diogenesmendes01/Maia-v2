/**
 * P9d Policy DSL — Bounded constants that guarantee totality + ReDoS safety.
 *
 * These bounds are **part of the Architecture Lock**. Loosening them changes
 * the worst-case runtime characteristics that the property tests + tinybench
 * benchmark were tuned for. Tightening them invalidates already-activated
 * `policy_rules` rows (a previously-valid policy could become un-evaluable).
 *
 * Any change to the numeric values requires founder approval.
 */

/**
 * Maximum nesting depth of `PolicyPredicate` (counting `and`/`or`/`not`
 * branches). Picked so a 16-deep balanced AND tree fits comfortably under the
 * 1ms p99 budget and below the JS engine's default stack limits.
 *
 * Predicates deeper than this resolve to `false` with
 * `predicate_depth_exceeded`. The validator rejects them at proposal time
 * with `predicate_too_deep`.
 */
export const MAX_PREDICATE_DEPTH = 16;

/**
 * Maximum number of dot-separated segments in a leaf `field` path
 * (e.g. `"a.b.c"` → 3 segments). 16 keeps lookups cheap and prevents
 * pathological keys built from untrusted inputs.
 *
 * Field paths exceeding this limit resolve to `undefined` and surface as
 * `field_path_depth_exceeded`.
 */
export const MAX_FIELD_PATH_DEPTH = 16;

/**
 * Maximum string length passed to a `matches` regex evaluation. The cap is
 * the second line of defence against ReDoS — even a `safe-regex2`-validated
 * pattern can degrade on long inputs combined with adversarial backtracking
 * shapes. 4096 covers every realistic policy field (descriptors, intent
 * names, channel ids) with margin.
 *
 * Inputs exceeding this length yield `regex_input_too_long`. The leaf
 * predicate evaluates to `false`.
 */
export const MAX_REGEX_INPUT_LENGTH = 4096;

/**
 * Maximum number of compiled `RegExp` instances cached by the evaluator.
 * The cache is keyed by raw pattern string (not by policy_id) so policies
 * sharing a pattern share the cache slot. LRU eviction keeps the working
 * set under control even with adversarial high-cardinality patterns.
 */
export const REGEX_CACHE_MAX = 256;

/**
 * Maximum number of predicate nodes (leaf + branch) in a single rule body.
 * Caps total runtime even when individual depth is small. A `policy_rules`
 * row with > `MAX_TOTAL_PREDICATE_NODES` predicates is rejected at proposal
 * time (`predicate_too_deep`) AND treated as inert at evaluation
 * (`predicate_depth_exceeded`).
 *
 * Picked as `MAX_PREDICATE_DEPTH * MAX_BRANCH_FANOUT` headroom (16 * 16 = 256)
 * with a safety multiplier — every realistic rule fits, oversized DoS-style
 * payloads do not.
 */
export const MAX_TOTAL_PREDICATE_NODES = 1024;

/**
 * Maximum number of direct children allowed on a single `and`/`or` branch.
 * Combined with `MAX_PREDICATE_DEPTH` and `MAX_TOTAL_PREDICATE_NODES`, this
 * bounds runtime even for syntactically valid but adversarial bodies.
 */
export const MAX_BRANCH_FANOUT = 64;

/**
 * Performance target documented for the tinybench benchmark. The benchmark
 * is informational (not a CI gate) so flaky CI runners don't fail the build,
 * but local runs must clear this. See `tests/benchmark/policy-dsl.bench.ts`.
 */
export const TARGET_P99_MICROS = 1000; // 1 ms

/** Effect actions accepted by the validator. */
export const ALLOWED_EFFECT_ACTIONS = [
  'allow',
  'block',
  'require_dual_approval',
  'warn',
  'log',
] as const;

/** Operators accepted by the evaluator. Extension requires Architecture Lock. */
export const ALLOWED_OPERATORS = [
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
] as const;

/** Predicate kinds accepted by the validator. */
export const ALLOWED_PREDICATE_KINDS = ['leaf', 'and', 'or', 'not'] as const;
