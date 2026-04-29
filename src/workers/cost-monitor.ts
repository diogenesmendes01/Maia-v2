import { config } from '@/config/env.js';
import { readDailyLLMUsd } from '@/lib/cost-ledger.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';

const THRESHOLD_USD_DEFAULT = 5;

/**
 * Daily LLM cost guard. Reads yesterday's accumulated cost (records are keyed
 * by UTC date, so at 02:30 BRT the prior day is fully closed) and alerts if
 * it exceeded the threshold. Fires once per day at most because the alert
 * subject is unique per day.
 */
export async function runCostMonitor(): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const usd = await readDailyLLMUsd(yesterday);
  const threshold = readThreshold();
  logger.info({ day: yesterday, usd, threshold }, 'cost_monitor.tick');
  if (usd <= threshold) return;
  await sendAlert({
    subject: `LLM cost $${usd.toFixed(2)} on ${yesterday} above $${threshold}`,
    body: `Daily LLM spend exceeded the configured threshold.\nDate: ${yesterday}\nUSD: ${usd.toFixed(2)}\nThreshold: ${threshold}\n\nCheck agent_facts['cost.daily.llm.${yesterday}'] for breakdown.`,
  });
}

function readThreshold(): number {
  const raw = (config as unknown as Record<string, unknown>).DAILY_LLM_USD_THRESHOLD;
  if (typeof raw === 'number' && raw > 0) return raw;
  return THRESHOLD_USD_DEFAULT;
}
