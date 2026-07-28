/**
 * Issue #514 §5 (LLM) — the FAILURE half of the LLM metric surface.
 *
 * `docs/runbooks/operational.md` already tells an operator to alert on
 * `maia_llm_calls_total{status="error"}`, but `src/lib/claude.ts` only
 * incremented the counter AFTER a successful call — so that series never
 * existed and the alert could never fire. This module supplies the missing
 * half, plus the retry/fallback counters the issue asks for.
 *
 * Cardinality discipline: the failure `reason` is a CLOSED enum derived from
 * the transport status code. The raw error message is never a label (it is
 * unbounded, and provider errors routinely echo request content) — it stays in
 * the log line.
 */
import { counter } from './metrics.js';
import { METRIC } from './taxonomy.js';

/** Closed vocabulary for why an LLM call failed. */
export type LlmFailureReason =
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'overloaded'
  | 'bad_request'
  | 'provider_error'
  | 'transport';

/**
 * Classify a provider error into the enum above using ONLY structural signals
 * (HTTP status, error name). Never inspects the message text: matching on
 * free-form provider prose is both brittle and a PII hazard.
 */
export function classifyLlmError(err: unknown): LlmFailureReason {
  const e = err as { status?: number; name?: string; code?: string } | null;
  if (!e) return 'transport';
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'aborted';

  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === undefined) {
    if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') return 'timeout';
    return 'transport';
  }
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 400 && status < 500) return 'bad_request';
  if (status >= 500) return 'provider_error';
  return 'transport';
}

export interface LlmCallLabels {
  provider: string;
  model: string;
  /** `main` or `fast` — which tier of the retry/fallback ladder. */
  tier?: 'main' | 'fast';
}

/**
 * Record a failed LLM call. This is the series
 * `maia_llm_calls_total{status="error"}` the runbook already references.
 */
export function recordLlmFailure(labels: LlmCallLabels, err: unknown): LlmFailureReason {
  const reason = classifyLlmError(err);
  counter(METRIC.LLM_CALLS, {
    provider: labels.provider,
    model: labels.model,
    tier: labels.tier ?? 'main',
    status: 'error',
    reason,
  });
  return reason;
}

/** Record a retry of the SAME tier (distinct from a fallback to another tier). */
export function recordLlmRetry(labels: LlmCallLabels, reason: LlmFailureReason): void {
  counter(METRIC.LLM_CALLS, {
    provider: labels.provider,
    model: labels.model,
    tier: labels.tier ?? 'main',
    status: 'retry',
    reason,
  });
}

/** Record the ladder dropping from the main model to the fast model. */
export function recordLlmFallback(labels: LlmCallLabels): void {
  counter(METRIC.LLM_CALLS, {
    provider: labels.provider,
    model: labels.model,
    tier: 'fast',
    status: 'fallback',
  });
}
