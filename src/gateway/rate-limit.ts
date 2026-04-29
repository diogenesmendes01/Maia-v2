import { redis, isRedisConnected } from '@/lib/redis.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import type { Pessoa } from '@/db/schema.js';

const COUNT_KEY = (pessoa_id: string): string => `maia:ratelimit:hour:${pessoa_id}`;
const WARNED_KEY = (pessoa_id: string): string => `maia:ratelimit:warned:${pessoa_id}`;
const SILENCE_KEY = (pessoa_id: string): string => `maia:ratelimit:silence:${pessoa_id}`;

const HOUR_MS = 3600 * 1000;
const HOUR_SECONDS = 3600;
const SILENCE_SECONDS = 60;

export type RateLimitDecision =
  | { kind: 'allow' }
  | { kind: 'warn'; count: number; threshold: number }
  | { kind: 'silence' };

/**
 * True sliding-hour message rate limit per spec 03 §9. Uses a Redis sorted
 * set keyed on `now_ms`: each call ZADDs the current timestamp, prunes
 * entries older than `now - 1h`, then reads ZCARD. Owners (dono/co_dono)
 * are exempt but still tracked so a runaway loop on the owner's number is
 * visible. Redis-down → fail-open for owners, fail-closed for everyone else.
 *
 * The previous implementation used INCR + EXPIRE-on-creation, which is a
 * fixed window: a non-owner could send 30 msgs at 10:59 and another 30 at
 * 11:00 and never trigger the limit. The sorted-set approach counts only
 * events inside the trailing 60 minutes regardless of when the key was born.
 */
export async function checkRateLimit(pessoa: Pessoa): Promise<RateLimitDecision> {
  const isOwner = pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono';
  if (!isRedisConnected()) {
    if (isOwner) return { kind: 'allow' };
    logger.warn({ pessoa_id: pessoa.id }, 'rate_limit.redis_down_fail_closed');
    return { kind: 'silence' };
  }

  const threshold = config.RATE_LIMIT_MSGS_PER_HOUR;
  const now = Date.now();
  const cutoff = now - HOUR_MS;
  const countKey = COUNT_KEY(pessoa.id);

  let count = 0;
  try {
    await redis.zremrangebyscore(countKey, 0, cutoff);
    // Score is `now`; member is `now-<rand>` to avoid collapsing concurrent
    // calls at the same millisecond onto a single set entry.
    await redis.zadd(countKey, now, `${now}-${Math.random().toString(36).slice(2, 10)}`);
    await redis.expire(countKey, HOUR_SECONDS);
    count = await redis.zcard(countKey);
  } catch (err) {
    logger.warn({ err: (err as Error).message, pessoa_id: pessoa.id }, 'rate_limit.zset_failed');
    return isOwner ? { kind: 'allow' } : { kind: 'silence' };
  }

  if (isOwner || count <= threshold) return { kind: 'allow' };

  const silenced = await redis.get(SILENCE_KEY(pessoa.id));
  if (silenced) return { kind: 'silence' };

  const warned = await redis.get(WARNED_KEY(pessoa.id));
  if (warned) {
    // Warning record exists but silence expired — re-arm silence without
    // sending another reply.
    await redis.set(SILENCE_KEY(pessoa.id), '1', 'EX', SILENCE_SECONDS);
    return { kind: 'silence' };
  }

  // First overage in this sliding hour — emit one polite reply, silence 60s.
  await redis.set(WARNED_KEY(pessoa.id), '1', 'EX', HOUR_SECONDS);
  await redis.set(SILENCE_KEY(pessoa.id), '1', 'EX', SILENCE_SECONDS);
  return { kind: 'warn', count, threshold };
}

export const POLITE_RATE_LIMIT_REPLY =
  'Você passou de {N} mensagens nessa última hora. Vou pausar por uns minutinhos para não te atropelar.';

export function formatPoliteReply(threshold: number): string {
  return POLITE_RATE_LIMIT_REPLY.replace('{N}', String(threshold));
}
