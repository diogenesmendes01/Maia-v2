/**
 * P9d Policy DSL — Barrel export.
 *
 * Public surface for consumers (P9b Decision Engine, P8e Policy Resolver,
 * Admin UI). Everything else is implementation detail.
 *
 * Architecture Lock: re-exporting new symbols here is an opt-in change to
 * the public surface and should be reviewed alongside any AST/operator
 * changes (`types.ts`, `constants.ts`).
 */

export { evaluate } from './evaluator.js';
export { validatePolicyRuleBody } from './validator.js';
export {
  compileSafeRegex,
  getRegexCacheStats,
  resetRegexCache,
} from './regex-cache.js';
export {
  resolveFieldPath,
  splitFieldPath,
  isFieldPathTooDeep,
} from './field-path.js';
export {
  ALLOWED_EFFECT_ACTIONS,
  ALLOWED_OPERATORS,
  ALLOWED_PREDICATE_KINDS,
  MAX_FIELD_PATH_DEPTH,
  MAX_PREDICATE_DEPTH,
  MAX_REGEX_INPUT_LENGTH,
  REGEX_CACHE_MAX,
  TARGET_P99_MICROS,
} from './constants.js';
export type {
  PolicyAndPredicate,
  PolicyComparableValue,
  PolicyDecision,
  PolicyEffect,
  PolicyEffectAction,
  PolicyEvaluationDiagnostics,
  PolicyEvaluationError,
  PolicyEvaluationErrorCode,
  PolicyLeafPredicate,
  PolicyNotPredicate,
  PolicyOperator,
  PolicyOrPredicate,
  PolicyPathSegment,
  PolicyPredicate,
  PolicyRuleBody,
  PolicyValidationError,
  PolicyValidationErrorCode,
  PolicyValidationResult,
} from './types.js';
