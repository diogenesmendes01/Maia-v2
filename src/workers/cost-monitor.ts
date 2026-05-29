import { config } from '@/config/env.js';
import { readDailyLLMUsd } from '@/lib/cost-ledger.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Daily LLM cost guard. Reads yesterday's accumulated cost (records are keyed
 * by UTC date, so at 02:30 BRT the prior day is fully closed) and alerts if
 * it exceeded the threshold. Fires once per day at most because the alert
 * subject is unique per day.
 */
export async function runCostMonitor(): Promise<void> {
  // NOT migrated to `system` in issue #323 phase 2 (intentionally held): unlike
  // the other "global" maintenance workers, this one is tenant-SCOPED via the
  // data plane. `readDailyLLMUsd` → `factsRepo.getByKey('global', …)` filters
  // `agent_facts` by `getCurrentTenant()`/`getCurrentAgent()`, and the matching
  // ledger row is WRITTEN by `recordLLMCost` during agent turns — which today
  // (FEATURE_MULTI_CHANNEL=off) run under `default/default`. Swapping the reader
  // to `system/system` would read a non-existent `(system, system, global, …)`
  // row → silently $0 every day → the threshold alert never fires. This is a
  // data-plane change, NOT data-plane neutral, so it does not belong in the
  // pure-swap phase. It must be fanned out / re-homed in a later phase together
  // with the per-tenant cost ledger (mirrors the plan's "revisit if cost
  // becomes per-tenant" caveat). Left on the legacy literal until then.
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const usd = await readDailyLLMUsd(yesterday);
    const threshold = config.DAILY_LLM_USD_THRESHOLD;
    logger.info({ day: yesterday, usd, threshold }, 'cost_monitor.tick');
    if (usd <= threshold) return;
    await sendAlert({
      subject: `LLM cost $${usd.toFixed(2)} on ${yesterday} above $${threshold}`,
      body: `Daily LLM spend exceeded the configured threshold.\nDate: ${yesterday}\nUSD: ${usd.toFixed(2)}\nThreshold: ${threshold}\n\nCheck agent_facts['cost.daily.llm.${yesterday}'] for breakdown.`,
    });
  });
}
