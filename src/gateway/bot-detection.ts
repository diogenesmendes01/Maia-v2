import { redis, isRedisConnected } from '@/lib/redis.js';
import { pessoasRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';

const KEY = (phone: string) => `maia:botdet:${phone}`;
const WINDOW_SECONDS = 60;
const THRESHOLD = 50; // > 50 msgs/min → auto-block per spec 05 §11.4

/**
 * Increment a sliding 60-second counter for the phone. If the count exceeds
 * THRESHOLD, set the corresponding pessoa to status='bloqueada' (when one
 * exists) and audit. Idempotent: subsequent triggers within the same window
 * are no-ops because the pessoa is already blocked.
 *
 * Returns true when the caller should drop the message (already-blocked or
 * just-blocked); false otherwise.
 */
export async function checkBotAndMaybeBlock(tel: string): Promise<boolean> {
  if (!isRedisConnected()) return false; // degraded: skip rather than fail-open
  let count = 0;
  try {
    count = await redis.incr(KEY(tel));
    if (count === 1) await redis.expire(KEY(tel), WINDOW_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'bot_detection.redis_failed');
    return false;
  }
  if (count <= THRESHOLD) return false;

  const pessoa = await pessoasRepo.findByPhone(tel);
  if (!pessoa) return true; // unknown number flooding → drop without action
  if (pessoa.status === 'bloqueada') return true;
  if (pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono') {
    // Never auto-block owners — log only.
    logger.warn({ pessoa_id: pessoa.id, count }, 'bot_detection.owner_threshold_exceeded');
    return false;
  }
  await pessoasRepo.updateStatus(pessoa.id, 'bloqueada');
  await audit({
    acao: 'auto_blocked_anomalous_volume',
    pessoa_id: pessoa.id,
    metadata: { count, window_seconds: WINDOW_SECONDS },
  });
  logger.warn({ pessoa_id: pessoa.id, count }, 'bot_detection.auto_blocked');
  return true;
}
