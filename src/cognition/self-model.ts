/**
 * Deterministic confidence formula for self-model capabilities.
 * NEVER calls LLM. Output is in [0, 1].
 *
 * confidence = success_rate × maturity_factor × recency_factor
 *   success_rate    = success_count / max(1, success_count + failure_count)
 *   maturity_factor = min(1, sqrt(evidence_count / N_MIN))
 *   recency_factor  = 1 if no failures, else 1 - exp(-days_since_last_failure / LAMBDA)
 *
 * N_MIN = 10 evidências pra plateau de maturidade.
 * LAMBDA = 30 dias pra recovery de falha recente (meia-vida ~21 dias).
 */

const N_MIN = 10;
const LAMBDA = 30;

export type ConfidenceInputs = {
  success_count: number;
  failure_count: number;
  evidence_count: number;
  days_since_last_failure: number;
};

/**
 * Compute deterministic confidence score based on historical evidence.
 * Returns value in [0, 1].
 *
 * - No evidence (evidence_count === 0) → 0
 * - All successes + no recent failures → approaches 1
 * - Recent failures → reduced by recency_factor
 * - Low evidence count → reduced by maturity_factor
 */
export function computeConfidence(args: ConfidenceInputs): number {
  if (args.evidence_count === 0) return 0;

  const total = args.success_count + args.failure_count;
  const successRate = total === 0 ? 0 : args.success_count / total;

  // Maturity: sqrt curve, saturates at evidence_count >= N_MIN
  const maturityFactor = Math.min(1, Math.sqrt(args.evidence_count / N_MIN));

  // Recency: if no failures ever, factor = 1 (full confidence).
  // Otherwise, exponential decay: recent failure (days=0) gives ~0,
  // old failure (days=large) gives ~1.
  const recencyFactor =
    args.failure_count === 0
      ? 1
      : 1 - Math.exp(-args.days_since_last_failure / LAMBDA);

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, successRate * maturityFactor * recencyFactor));
}

/**
 * Helper: compute days_since_last_failure from a Date (or null = "never failed")
 * Clamps to reasonable range [0, 365] to avoid numerical extremes.
 */
export function daysSinceLastFailure(lastFailure: Date | null): number {
  if (!lastFailure) return 365; // Never failed → treat as very old failure
  const days = (Date.now() - lastFailure.getTime()) / (1000 * 60 * 60 * 24);
  return Math.min(365, Math.max(0, days));
}
