/**
 * Issue #514 §5 (Fila) — queue depth, oldest job age, backlog by state.
 *
 * These are the two SLIs the issue singles out ("Queue depth e oldest age
 * estão disponíveis", "oldest agent job < 2s em operação normal") and the ones
 * that make a latency incident attributable: a p95 blowup with a flat queue is
 * a DB/LLM problem, the same blowup with a growing `oldest_job_age` is a
 * capacity problem.
 *
 * Implemented as SCRAPE-TIME gauge providers rather than counters so the
 * values are correct with multiple replicas: every replica reports the same
 * shared Redis queue, so Prometheus sees N identical series that `max by
 * (queue, state)` collapses correctly. A counter incremented per replica would
 * have to be summed and would drift on restart.
 *
 * Failure posture: a provider that cannot reach Redis returns NaN (via
 * `metrics.gauge`), never 0 — issue #514 invariant "métrica ausente não é
 * interpretada como zero saudável". A dashboard that plots 0 for a dead Redis
 * is worse than one that plots a gap.
 */
import type { Queue } from 'bullmq';
import { gauge } from './metrics.js';
import { METRIC } from './taxonomy.js';

/** States we expose. Bounded, enumerated — safe as a label. */
const TRACKED_STATES = ['waiting', 'active', 'delayed', 'failed', 'paused'] as const;
type TrackedState = (typeof TRACKED_STATES)[number];

/**
 * Age (ms) of the oldest job still waiting. `getJobs(['waiting'], 0, 0, true)`
 * asks Redis for the FIRST job in ascending order — one entry, not the whole
 * backlog, so this stays O(1) regardless of queue size.
 */
async function oldestWaitingAgeMs(queue: Queue): Promise<number> {
  const jobs = await queue.getJobs(['waiting'], 0, 0, true);
  const oldest = jobs[0];
  if (!oldest || typeof oldest.timestamp !== 'number') return 0;
  return Math.max(0, Date.now() - oldest.timestamp);
}

/**
 * Register depth + age gauges for `queue`.
 *
 * Idempotent: `setGaugeProvider` is keyed by series name, so calling this
 * twice (test harness, hot reload) replaces the provider instead of stacking.
 */
export function registerQueueGauges(queue: Queue, name: string): void {
  for (const state of TRACKED_STATES) {
    gauge(
      METRIC.QUEUE_DEPTH,
      async () => {
        const counts = await queue.getJobCounts(...TRACKED_STATES);
        const v = (counts as Record<TrackedState, number | undefined>)[state];
        // A state Redis did not report is unknown, not zero.
        return typeof v === 'number' ? v : Number.NaN;
      },
      { queue: name, state },
    );
  }

  gauge(METRIC.QUEUE_OLDEST_JOB_AGE_MS, () => oldestWaitingAgeMs(queue), { queue: name });
}

/** Exposed for tests — the state set the gauges cover. */
export const _TRACKED_STATES = TRACKED_STATES;
