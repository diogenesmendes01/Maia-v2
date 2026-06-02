import { runOutboxDrain } from '@/scheduling/outbox-drain.js';
import { schedulingDispatch } from '@/scheduling/repos.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Spec 18 §7.2 — Blocker 4 (review 2) + Issue #355 (per-tenant scoping).
 *
 * The cron fires this worker once per minute, but the rate gate
 * (`OUTBOX_MAX_PER_SECOND`) is per-second. To drain a deep backlog at
 * the documented cadence (default ~1 msg/s), the worker must loop
 * within one firing rather than process a single batch and exit.
 *
 * Issue #355: the outbox is now tenant-scoped, so the drain MUST run inside a
 * tenant context. The worker is a dispatcher — it enumerates the DISTINCT
 * `(tenant_id, agent_id)` tuples with sendable/reclaimable outbox rows and runs
 * the pass-loop once per tuple under `runWithTenantContext`, fail-isolated
 * (one tenant's error doesn't abort the others). Mirrors reflection-batch
 * (#240/#251). NO `'default'` sentinel.
 *
 * Per-tenant loop semantics (unchanged from the original single-context loop):
 *   - Run `runOutboxDrain()` once.
 *   - If nothing was claimed → break early (this tenant's queue is empty).
 *   - If any row hit the rate gate → sleep `OUTBOX_DRAIN_LOOP_SLEEP_MS`
 *     so the per-second bucket refills, then continue.
 *   - Cap iterations at `OUTBOX_DRAIN_LOOP_PASSES` so we don't run past
 *     the next cron firing.
 *
 * Gated by FEATURE_SCHEDULING_V2 (default OFF): skipped entirely when off
 * (and `runOutboxDrain` also early-returns).
 */
async function drainTenant(maxPasses: number, sleepMs: number): Promise<void> {
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

export async function runOutboxDrainWorker(): Promise<void> {
  if (!config.FEATURE_SCHEDULING_V2) return;

  const maxPasses = Math.max(1, config.OUTBOX_DRAIN_LOOP_PASSES);
  const sleepMs = Math.max(0, config.OUTBOX_DRAIN_LOOP_SLEEP_MS);

  const tenants = await schedulingDispatch.enumerateOutboxTenants();
  if (tenants.length === 0) {
    logger.debug('outbox_drain_worker.idle');
    return;
  }

  let tenantsProcessed = 0;
  let tenantsFailed = 0;

  for (const { tenant_id, agent_id } of tenants) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, () =>
        drainTenant(maxPasses, sleepMs),
      );
      tenantsProcessed++;
    } catch (err) {
      tenantsFailed++;
      logger.warn(
        { tenant_id, agent_id, err: (err as Error).message, stack: (err as Error).stack },
        'outbox_drain_worker.tenant_failed',
      );
    }
  }

  logger.info(
    {
      tenants: tenants.length,
      tenants_processed: tenantsProcessed,
      tenants_failed: tenantsFailed,
    },
    'outbox_drain_worker.done',
  );
}
