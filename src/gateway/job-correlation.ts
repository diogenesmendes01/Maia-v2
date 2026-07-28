/**
 * Issue #514 §1 — correlation stamping for `AgentJob` payloads.
 *
 * Lives in its own module (not in `queue.ts`) on purpose: `debouncer.ts` needs
 * it too, and the debouncer's unit suite mocks `queue.js` wholesale. Importing
 * the stamper from the mocked module would force every one of those specs to
 * re-declare it. A leaf module with no Redis/BullMQ import is also trivially
 * unit-testable and adds no startup cost.
 */
import { correlationForJob } from '@/observability/correlation.js';
import type { AgentJob } from './types.js';

/**
 * Return `data` with the turn's correlation fields stamped on.
 *
 * Precedence:
 *   - `trace_id` supplied by the caller WINS — the recovery sweep and the
 *     unrouted replay re-enqueue an existing turn and must keep its root.
 *   - otherwise the id is DERIVED from `mensagem_id`, so re-enqueueing the
 *     same row (crash recovery, debounce reset, DLQ replay) always lands on
 *     the same root trace with no state carried between attempts.
 *
 * `enqueued_at_ms` is always refreshed: it measures THIS arming, which is what
 * the queue-wait SLI wants (a debounce reset legitimately restarts the clock).
 */
export function withCorrelation(data: AgentJob): AgentJob {
  const derived = correlationForJob(data.mensagem_id, data.received_at_ms);
  return {
    ...data,
    trace_id: data.trace_id ?? derived.trace_id,
    enqueued_at_ms: derived.enqueued_at_ms,
    ...(derived.received_at_ms != null ? { received_at_ms: derived.received_at_ms } : {}),
  };
}
