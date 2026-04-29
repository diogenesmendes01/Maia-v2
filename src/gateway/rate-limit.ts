import { redis, isRedisConnected } from '@/lib/redis.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import type { Pessoa } from '@/db/schema.js';

const COUNT_KEY = (pessoa_id: string) => `maia:ratelimit:hour:${pessoa_id}`;
const WARNED_KEY = (pessoa_id: string) => `maia:ratelimit:warned:${pessoa_id}`;
const SILENCE_KEY = (pessoa_id: string) => `maia:ratelimit:silence:${pessoa_id}`;

const HOUR_SECONDS = 3600;
const SILENCE_SECONDS = 60;

export type RateLimitDecision =
  | { kind: 'allow' }
  | { kind: 'warn'; count: number; threshold: number } // first time crossing threshold this hour
  | { kind: 'silence' }; // already warned within the silence window

/**
 * Sliding-hour message rate limit per spec 03 §9. Owners (dono/co_dono) are
 * exempt but still tracked so a runaway loop on the owner's number is visible
 * in metrics. Redis-down → fail-open for the owner, fail-closed for everyone
 * else (refuse to enqueue work without a guard against floods).
 */
export async function checkRateLimit(pessoa: Pessoa): Promise<RateLimitDecision> {
  const isOwner = pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono';
  if (!isRedisConnected()) {
    if (isOwner) return { kind: 'allow' };
    logger.warn({ pessoa_id: pessoa.id }, 'rate_limit.redis_down_fail_closed');
    return { kind: 'silence' };
  }

  const threshold = config.RATE_LIMIT_MSGS_PER_HOUR;
  let count = 0;
  try {
    count = await redis.incr(COUNT_KEY(pessoa.id));
    if (count === 1) await redis.expire(COUNT_KEY(pessoa.id), HOUR_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message, pessoa_id: pessoa.id }, 'rate_limit.incr_failed');
    return isOwner ? { kind: 'allow' } : { kind: 'silence' };
  }

  if (isOwner || count <= threshold) return { kind: 'allow' };

  // Over threshold. Was this pessoa already warned this hour?
  const silenced = await redis.get(SILENCE_KEY(pessoa.id));
  if (silenced) return { kind: 'silence' };

  const warned = await redis.get(WARNED_KEY(pessoa.id));
  if (warned) {
    // Re-warned (warning expired), but we silence for 60s before any further reply.
    await redis.set(SILENCE_KEY(pessoa.id), '1', 'EX', SILENCE_SECONDS);
    return { kind: 'silence' };
  }

  // First overage this hour — emit one polite reply, then silence for 60s.
  await redis.set(WARNED_KEY(pessoa.id), '1', 'EX', HOUR_SECONDS);
  await redis.set(SILENCE_KEY(pessoa.id), '1', 'EX', SILENCE_SECONDS);
  return { kind: 'warn', count, threshold };
}

export const POLITE_RATE_LIMIT_REPLY =
  'Você passou de {N} mensagens nessa última hora. Vou pausar por uns minutinhos para não te atropelar.';

export function formatPoliteReply(threshold: number): string {
  return POLITE_RATE_LIMIT_REPLY.replace('{N}', String(threshold));
}
