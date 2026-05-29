/**
 * Spec 18 §7.2 — outbox-drain backpressure.
 *
 * Three independent gates:
 *   1. Global rate (per-second AND per-hour token buckets in Redis)
 *   2. Per-recipient pacing (2s minimum gap on the same jid)
 *   3. Worker concurrency cap (enforced by the caller via Promise.all width)
 *
 * Redis is required. When Redis is unavailable, the backpressure layer
 * fails CLOSED — we refuse to send rather than risk burst-banning the
 * WhatsApp account. The outbox row stays `pending` and the next tick
 * retries.
 */

import { isRedisConnected, redis } from '@/lib/redis.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { buildCacheKey } from '@/lib/cache-key.js';

const PACE_TTL_SECONDS = 2;

export type RateDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: 'redis_down' | 'per_second' | 'per_hour' | 'per_recipient' };

/**
 * Atomically attempt to acquire one send slot. Burns one token from the
 * per-second and per-hour buckets, AND sets the per-recipient pace key.
 *
 * IMPORTANT: this is a best-effort counter. We use INCR + EXPIRE rather
 * than a strict leaky-bucket, which can over-count by ~1 at window
 * boundaries — that's the right tradeoff for a single-tenant deployment.
 */
export async function tryAcquireSendSlot(jid: string): Promise<RateDecision> {
  if (!isRedisConnected()) return { kind: 'deny', reason: 'redis_down' };

  // Per-recipient pace: SET NX EX. If exists, deny.
  // Issue #287: route every Redis key through `buildCacheKey` so the
  // collision-by-delimiter contract is enforced centrally. `jid` strings
  // contain `@` which is now URI-encoded — Redis keys remain unique, only
  // the wire format changed.
  const paceKey = buildCacheKey('outbox:pace:', jid);
  const paceOk = await redis.set(paceKey, '1', 'EX', PACE_TTL_SECONDS, 'NX');
  if (paceOk === null) return { kind: 'deny', reason: 'per_recipient' };

  // Per-second bucket.
  const secKey = buildCacheKey('outbox:rate:sec:', Math.floor(Date.now() / 1000));
  const sec = await redis.incr(secKey);
  if (sec === 1) await redis.expire(secKey, 2);
  if (sec > config.OUTBOX_MAX_PER_SECOND) {
    await redis.del(paceKey).catch(() => null);
    return { kind: 'deny', reason: 'per_second' };
  }

  // Per-hour bucket.
  const hourKey = buildCacheKey('outbox:rate:hour:', Math.floor(Date.now() / 3600_000));
  const hour = await redis.incr(hourKey);
  if (hour === 1) await redis.expire(hourKey, 3700);
  if (hour > config.OUTBOX_MAX_PER_HOUR) {
    await redis.del(paceKey).catch(() => null);
    return { kind: 'deny', reason: 'per_hour' };
  }

  return { kind: 'allow' };
}

/**
 * Release the per-recipient pace key on send failure so a retry isn't
 * blocked by the same recipient's brief lockout. Per-second/hour tokens
 * are NOT refunded — they were the cost of attempting; refunding would
 * let a flapping send pound WhatsApp.
 */
export async function releasePaceKey(jid: string): Promise<void> {
  if (!isRedisConnected()) return;
  // Must match the encoding used by `tryAcquireSendSlot` above — otherwise
  // we'd `DEL` a key that was never `SET` and leave the actual lockout in place.
  await redis.del(buildCacheKey('outbox:pace:', jid)).catch((err) => {
    logger.debug({ err: (err as Error).message }, 'backpressure.release_pace_failed');
  });
}
