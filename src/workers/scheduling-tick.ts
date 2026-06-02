/**
 * Issue #355 — scheduling_tick worker: per-tenant dispatcher.
 *
 * The Spec-18 scheduling tables now carry `tenant_id`/`agent_id` and every
 * query in `src/scheduling/*` scopes by the ALS tenant context. The engine
 * tick (`runSchedulingTick`) therefore MUST run inside a tenant context.
 *
 * This worker is a dispatcher: it enumerates the DISTINCT `(tenant_id,
 * agent_id)` tuples with claimable/advanceable occurrences and runs the engine
 * tick once per tuple under `runWithTenantContext`, fail-isolated (one tenant's
 * error never aborts the loop). Mirrors the reflection-batch (#240/#251) /
 * outbound-messages-sweeper (#292) idiom. NO `'default'` sentinel — a tuple
 * appears only if it genuinely has work. Unlike reflection-batch, this
 * dispatcher takes no advisory lock and needs none: the repos' `FOR UPDATE
 * SKIP LOCKED` claim CTEs already stop two instances from double-claiming.
 *
 * Gated by FEATURE_SCHEDULING_V2 (default OFF): when off we skip the enumeration
 * entirely (and `runSchedulingTick` also early-returns), so the worker is a
 * no-op until the flag is flipped.
 */
import { runSchedulingTick } from '@/scheduling/engine.js';
import { schedulingDispatch } from '@/scheduling/repos.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runScheduling(): Promise<void> {
  if (!config.FEATURE_SCHEDULING_V2) return;

  const tenants = await schedulingDispatch.enumerateTickTenants();
  if (tenants.length === 0) {
    logger.debug('scheduling_tick.idle');
    return;
  }

  let tenantsProcessed = 0;
  let tenantsFailed = 0;
  let totalClaimed = 0;
  let totalAdvanced = 0;

  for (const { tenant_id, agent_id } of tenants) {
    try {
      const r = await runWithTenantContext({ tenant_id, agent_id }, () =>
        runSchedulingTick(),
      );
      totalClaimed += r.claimed;
      totalAdvanced += r.advanced + r.in_progress_advanced;
      tenantsProcessed++;
    } catch (err) {
      // Fail-isolated: one tenant's failure must not stop the others.
      tenantsFailed++;
      logger.warn(
        { tenant_id, agent_id, err: (err as Error).message, stack: (err as Error).stack },
        'scheduling_tick.tenant_failed',
      );
    }
  }

  logger.info(
    {
      tenants: tenants.length,
      tenants_processed: tenantsProcessed,
      tenants_failed: tenantsFailed,
      claimed: totalClaimed,
      advanced: totalAdvanced,
    },
    'scheduling_tick.done',
  );
}
