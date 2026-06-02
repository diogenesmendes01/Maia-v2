import { config } from '@/config/env.js';
import { readDailyLLMUsd } from '@/lib/cost-ledger.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { runWithSystemContext } from '@/db/tenant-context.js';

/**
 * Daily LLM cost guard. Reads yesterday's accumulated cost (records are keyed
 * by UTC date, so at 02:30 BRT the prior day is fully closed) and alerts if
 * it exceeded the threshold. Fires once per day at most because the alert
 * subject is unique per day.
 */
export async function runCostMonitor(): Promise<void> {
  // Flip-readiness (#345 / #323): re-homed off the legacy `default/default`
  // literal to the reserved `system` sentinel (`runWithSystemContext`), mirroring
  // the sibling global maintenance workers (health-monitor / idempotency-cleanup
  // / dlq-monitor). The daily LLM cost guard is a GLOBAL maintenance sweep with
  // no owning tenant, and parking it on the raw `'default'` literal would make it
  // throw `DefaultLiteralRejectedError` (via `factsRepo.getByKey` →
  // `getCurrentTenant()`) once `MAIA_REJECT_DEFAULT_LITERAL` flips on. `system`
  // is explicitly NOT rejected by `assertNotDefaultLiteral`, so the worker stays
  // up after the flip.
  //
  // KNOWN DATA-PLANE CAVEAT (tracked deferral — see commit body): the cost ledger
  // is read tenant-scoped — `readDailyLLMUsd` → `factsRepo.getByKey('global', …)`
  // filters `agent_facts` by the ALS `tenant_id`/`agent_id`, and the matching
  // aggregate row is WRITTEN by `recordLLMCost` (src/lib/claude.ts) under whatever
  // context the agent turn runs in, which today (FEATURE_MULTI_CHANNEL=off) is
  // `default/default`. Reading under `system` therefore looks up a
  // `(system, system, 'global', …)` row that no writer produces today → $0 until
  // the WRITER side (cost-ledger / claude.ts, OUT OF SCOPE here) is re-homed to
  // `system` or fanned out per-tenant. This is the safe-to-flip step (no throw,
  // no crash); restoring the non-zero reading is a follow-up on the writer path.
  await runWithSystemContext(async () => {
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
