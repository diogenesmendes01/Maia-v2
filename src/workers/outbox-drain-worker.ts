import { runOutboxDrain } from '@/scheduling/outbox-drain.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

/**
 * Spec 18 §7.2 — Blocker 4 (review 2).
 *
 * The cron fires this worker once per minute, but the rate gate
 * (`OUTBOX_MAX_PER_SECOND`) is per-second. To drain a deep backlog at
 * the documented cadence (default ~1 msg/s), the worker must loop
 * within one firing rather than process a single batch and exit.
 *
 * Loop semantics:
 *   - Run `runOutboxDrain()` once.
 *   - If nothing was claimed → break early (queue is empty).
 *   - If all claimed rows were sent and there's likely more → continue
 *     immediately (more headroom in the per-second bucket).
 *   - If any row hit the rate gate → sleep `OUTBOX_DRAIN_LOOP_SLEEP_MS`
 *     so the per-second bucket refills, then continue.
 *   - Cap iterations at `OUTBOX_DRAIN_LOOP_PASSES` so we don't run past
 *     the next cron firing.
 */
export async function runOutboxDrainWorker(): Promise<void> {
  const maxPasses = Math.max(1, config.OUTBOX_DRAIN_LOOP_PASSES);
  const sleepMs = Math.max(0, config.OUTBOX_DRAIN_LOOP_SLEEP_MS);

  for (let pass = 0; pass < maxPasses; pass++) {
    let result;
    try {
      result = await runOutboxDrain();
    } catch (err) {
      logger.warn({ err: (err as Error).message, pass }, 'outbox_drain_worker.pass_failed');
      break;
    }
    // Empty queue: nothing to do until next cron tick.
    if (result.drained === 0 && result.reclaimed === 0) break;
    // Rate-limited: refill the per-second bucket before next pass.
    if (result.rate_limited > 0 && sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
}
