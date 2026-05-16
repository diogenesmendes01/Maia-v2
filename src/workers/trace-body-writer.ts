/**
 * P10b — `trace-body-writer` worker (every minute).
 *
 * Drains the in-process queue of body inputs that the request path
 * fire-and-forgets. Uses ON CONFLICT DO NOTHING for idempotency.
 *
 * The queue is process-local (Node Map of trace_id → input). Workers in
 * other replicas will see envelopes with body_status='pending'; the
 * `trace-body-recoverer` cron handles cross-replica orphans (slower path).
 *
 * If a process crashes with un-flushed bodies, the recoverer rebuilds them
 * from the envelope alone (limited information — that's why we lean on
 * the fast path here to drain promptly).
 */
import { logger } from '@/lib/logger.js';
import { writeBody } from '@/control-plane/runtime-trace/body-writer.js';
import type { TraceBodyInput } from '@/control-plane/runtime-trace/types.js';
import { incCounter } from '@/lib/metrics.js';

// Process-local queue. Single-writer (this worker), single-consumer (db).
// Keyed by trace_id so a re-enqueue from the same process collapses.
const QUEUE = new Map<string, TraceBodyInput>();

/** Enqueue a body for async write. Idempotent per trace_id within a process. */
export function enqueueBody(input: TraceBodyInput): void {
  QUEUE.set(input.trace_id, input);
}

/** Test helper. */
export function _peekQueueSize(): number {
  return QUEUE.size;
}

/** Worker entrypoint. Drains the queue with bounded fan-out. */
export async function runTraceBodyWriter(): Promise<void> {
  if (QUEUE.size === 0) return;
  const drained = Array.from(QUEUE.values());
  QUEUE.clear();
  let ok = 0;
  let failed = 0;
  for (const input of drained) {
    try {
      await writeBody(input);
      ok += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { err: (err as Error).message, trace_id: input.trace_id },
        'trace_body_writer.failed',
      );
      // Re-enqueue for next tick. The recoverer covers cross-process gaps.
      QUEUE.set(input.trace_id, input);
    }
  }
  incCounter('maia_runtime_trace_body_writer_ok_total', {}, ok);
  if (failed > 0) incCounter('maia_runtime_trace_body_writer_failed_total', {}, failed);
  logger.info({ ok, failed }, 'trace_body_writer.tick');
}
