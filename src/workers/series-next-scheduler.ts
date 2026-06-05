/**
 * Issue #355 — series_next_scheduler worker: per-tenant dispatcher.
 *
 * The backfill scheduler (`runSeriesNextScheduler`) reads/writes the
 * tenant-scoped scheduling tables, so it MUST run inside a tenant context.
 * This worker enumerates the DISTINCT `(tenant_id, agent_id)` tuples that own
 * an active rrule-driven series and runs the backfill once per tuple under
 * `runWithTenantContext`, fail-isolated. Mirrors reflection-batch (#240/#251).
 * NO `'default'` sentinel. Takes no advisory lock (unlike reflection-batch):
 * concurrency safety lives in the scheduling repos (claim CTEs / occurrence
 * dedup), not in this dispatcher.
 *
 * Scheduling V2 is 100% cutover (#406 removed FEATURE_SCHEDULING_V2), so this
 * worker always runs; it cleanly no-ops when no tenant has an active series.
 */
import { runSeriesNextScheduler } from '@/scheduling/engine.js';
import { schedulingDispatch } from '@/scheduling/repos.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runSeriesNextSchedulerWorker(): Promise<void> {
  const tenants = await schedulingDispatch.enumerateActiveSeriesTenants();
  if (tenants.length === 0) {
    logger.debug('series_next_scheduler.idle');
    return;
  }

  let tenantsProcessed = 0;
  let tenantsFailed = 0;
  let totalScheduled = 0;

  for (const { tenant_id, agent_id } of tenants) {
    try {
      const r = await runWithTenantContext({ tenant_id, agent_id }, () =>
        runSeriesNextScheduler(),
      );
      totalScheduled += r.scheduled;
      tenantsProcessed++;
    } catch (err) {
      tenantsFailed++;
      logger.warn(
        { tenant_id, agent_id, err: (err as Error).message, stack: (err as Error).stack },
        'series_next_scheduler.tenant_failed',
      );
    }
  }

  logger.info(
    {
      tenants: tenants.length,
      tenants_processed: tenantsProcessed,
      tenants_failed: tenantsFailed,
      scheduled: totalScheduled,
    },
    'series_next_scheduler.done',
  );
}
