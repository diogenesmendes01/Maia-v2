import { config } from '@/config/env.js';
import { dlqRepo } from '@/db/repositories.js';
import { sendAlert } from '@/lib/alerts.js';
import { redis } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';

/**
 * DLQ size guard. Reads the count of unresolved entries in `dead_letter_jobs`
 * and fires an ops alert when it exceeds `DLQ_ALERT_THRESHOLD`.
 *
 * Idempotency: the last-alerted timestamp lives in Redis under
 * `maia:dlq_monitor:alerted` with a 1h TTL, so a sustained backlog only emits
 * one alert per hour rather than one every 5min cron tick.
 *
 * If no usable alert channel is configured (`config.ALERT_CHANNELS` empty or
 * only `log`), `sendAlert` is a no-op; we still log a high-severity record
 * with tag `dlq.threshold_exceeded` so an external log pipeline can pick up
 * the signal.
 */
const ALERT_KEY = 'maia:dlq_monitor:alerted';
const ALERT_TTL_S = 60 * 60; // 1h

export async function runDlqMonitor(): Promise<void> {
  let count: number;
  try {
    count = await dlqRepo.countOpen();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'dlq_monitor.count_failed');
    return;
  }
  const threshold = config.DLQ_ALERT_THRESHOLD;
  logger.debug({ count, threshold }, 'dlq_monitor.tick');
  if (count <= threshold) return;

  // Redis-backed throttle so a sustained backlog doesn't spam every 5min.
  // SET … NX EX returns 'OK' when the key was set (i.e. no recent alert);
  // null when the key already exists.
  let acquired: boolean;
  try {
    const result = await redis.set(ALERT_KEY, String(Date.now()), 'EX', ALERT_TTL_S, 'NX');
    acquired = result === 'OK';
  } catch (err) {
    // Redis down: best-effort, fall through to alert. The alert itself is
    // idempotent enough for ops (subject is constant), and missing the
    // throttle is preferable to silently dropping a real backlog signal.
    logger.warn({ err: (err as Error).message }, 'dlq_monitor.redis_throttle_failed');
    acquired = true;
  }
  if (!acquired) {
    logger.debug({ count, threshold }, 'dlq_monitor.alert_throttled');
    return;
  }

  logger.error({ count, threshold, tag: 'dlq.threshold_exceeded' }, 'dlq_monitor.threshold_exceeded');

  await sendAlert({
    subject: `DLQ size ${count} above threshold ${threshold}`,
    body: `Dead-letter queue has ${count} unresolved jobs (threshold: ${threshold}).\n\nUse \`tsx scripts/dlq.ts list\` to inspect, then \`retry <id>\` or \`resolve <id>\`.`,
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'dlq_monitor.alert_send_failed'),
  );

  await audit({
    acao: 'dlq_alert_emitted',
    metadata: { count, threshold },
  });
}
