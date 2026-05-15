/**
 * Confidence — deterministic confidence derivation from observable evidence.
 *
 * North-star invariant (project memory `project_self_model_design` /
 * `project_reflection_pipeline_design`): "confidence is ALWAYS derived from
 * a deterministic formula over evidence, NEVER from the LLM". This module is
 * the canonical place to compute confidence values for facts and rules.
 *
 * Initial P1 strategy (minimal): brand-new candidates start at a LOW initial
 * confidence (0.5). Evidence accumulation in P2+ raises confidence via the
 * formulas below; this module owns those formulas so future phases consume
 * one source of truth.
 *
 * The LLM may emit a `confianca_sugerida` field in its JSON, but the
 * persister discards it. It is metadata only — never the canonical value.
 */

/** Initial confidence for a fact at first observation (no corroborating evidence yet). */
export const FACT_INITIAL_CONFIDENCE = 0.5;

/** Initial confidence for a rule at first observation. Lower than fact because rules generalize. */
export const RULE_INITIAL_CONFIDENCE = 0.5;

/**
 * P1: initial confidence for a freshly observed fact.
 * P2+: replace with `factConfidence({ evidence_count, recency_days, source_quality })`.
 */
export function initialFactConfidence(): number {
  return FACT_INITIAL_CONFIDENCE;
}

/**
 * P1: initial confidence for a freshly observed rule.
 * P2+: extend with `ruleConfidence({ acertos, erros, evidence_count })` — likely
 * Wilson lower bound on the success ratio, plus a recency decay.
 */
export function initialRuleConfidence(): number {
  return RULE_INITIAL_CONFIDENCE;
}
