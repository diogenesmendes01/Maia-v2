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

import {
  isRedisConnected,
  redis,
  isRedisOomError,
  recordRedisOomDegraded,
  recordRedisError,
} from '@/lib/redis.js';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { buildCacheKey } from '@/lib/cache-key.js';

const PACE_TTL_SECONDS = 2;

export type RateDecision =
  | { kind: 'allow' }
  | {
      kind: 'deny';
      reason: 'redis_down' | 'redis_oom' | 'per_second' | 'per_hour' | 'per_recipient';
    };

/**
 * Best-effort cleanup of the pace key after a rate-bucket deny. The slot
 * decision has ALREADY been made (we're returning `deny`), so this `DEL` must
 * never throw or change control flow — but it must not be invisible either
 * (#309 review, PR #324). Classify the failure: an OOM is a capacity incident
 * (`recordRedisOomDegraded`), any other fault is a real Redis error
 * (`recordRedisError` + structured warn). Either way we swallow and return.
 *
 * Why best-effort is still correct: the pace key has a 2s TTL, so a failed
 * cleanup at worst delays the NEXT send to this jid by up to 2s — it never
 * blocks indefinitely and never affects a different recipient.
 */
async function cleanupPaceKey(paceKey: string): Promise<void> {
  try {
    await redis.del(paceKey);
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('backpressure.cleanup');
    } else {
      recordRedisError('backpressure.cleanup');
      logger.warn(
        { err: (err as Error).message },
        'backpressure.cleanup_pace_failed',
      );
    }
  }
}

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

  // OOM handling (#309): the backpressure gate is FAIL-CLOSED by design (see
  // the module docblock — Redis is required; refusing to send beats risking a
  // WhatsApp burst-ban). A Redis OOM under `noeviction` is therefore treated
  // exactly like Redis-down: we deny with a dedicated `redis_oom` reason so the
  // outbox row stays `pending` and the next tick retries (the caller in
  // `outbox-drain.ts` maps any unknown reason to a 30s backoff). Crucially this
  // is NOT fail-open: silently allowing the send on OOM could double-send (the
  // pace/rate counters never landed) or burst-ban the account. A raw
  // `ReplyError` must never escape to crash the drain loop. Non-OOM Redis
  // errors still propagate to the drain loop's own try/catch.
  try {
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
      await cleanupPaceKey(paceKey);
      return { kind: 'deny', reason: 'per_second' };
    }

    // Per-hour bucket.
    const hourKey = buildCacheKey('outbox:rate:hour:', Math.floor(Date.now() / 3600_000));
    const hour = await redis.incr(hourKey);
    if (hour === 1) await redis.expire(hourKey, 3700);
    if (hour > config.OUTBOX_MAX_PER_HOUR) {
      await cleanupPaceKey(paceKey);
      return { kind: 'deny', reason: 'per_hour' };
    }

    return { kind: 'allow' };
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('backpressure.acquire');
      return { kind: 'deny', reason: 'redis_oom' };
    }
    throw err;
  }
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
