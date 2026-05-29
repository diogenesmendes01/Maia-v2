import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';

export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
});

/**
 * Detect a Redis OOM (out-of-memory) error — issue #309.
 *
 * Under `maxmemory 2gb` + `maxmemory-policy noeviction` (PR #294, see
 * `docs/runbooks/redis.md` §1) a write command issued while Redis is at its
 * memory cap is REJECTED with a reply error rather than evicting another
 * tenant's key. ioredis surfaces that as a `ReplyError` whose message begins
 * with the Redis error prefix `OOM`:
 *
 *   ReplyError: OOM command not allowed when used memory > 'maxmemory'.
 *
 * The error is built by `redis-parser` as `new ReplyError(<full reply text>)`
 * (see `node_modules/redis-parser/lib/parser.js:parseError`), so the OOM
 * signal lives in `err.message` (and `err.name === 'ReplyError'`). No
 * dedicated numeric `.code` is set by ioredis itself, but some wrappers
 * (ioredis-mock, re-thrown errors) attach a string `.code`, so we accept a
 * `.code` of `'OOM'` too for defense-in-depth.
 *
 * Detection is intentionally narrow: it matches the `OOM` reply prefix
 * (case-insensitive, token-anchored) and NOT any message that merely
 * contains the substring "oom" (e.g. "zoom", "room"). We anchor on the
 * leading token because Redis always emits the error code as the first
 * word of the reply.
 *
 * This is the SINGLE source of truth for "is this an OOM?" so every caller
 * degrades on the same condition (see callers in `src/memory/working.ts`,
 * `src/gateway/dedup.ts`, `src/gateway/debouncer.ts`,
 * `src/tools/_vision-cache.ts`, `src/gateway/bot-detection.ts`,
 * `src/scheduling/backpressure.ts`). Per-caller degrade vs. fail-closed
 * policy is documented at each call site and in the runbook §4.5.
 */
export function isRedisOomError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };

  // Some clients/wrappers set a string code directly.
  if (typeof e.code === 'string' && e.code.toUpperCase() === 'OOM') return true;

  // Canonical path: an ioredis `ReplyError` whose message starts with the
  // `OOM` reply prefix. We require the leading token to be exactly `OOM`
  // (followed by end-of-string or a non-alphanumeric separator) so we never
  // false-positive on words like "zoom".
  if (typeof e.message !== 'string') return false;
  const isReplyError = e.name === 'ReplyError';
  const startsWithOom = /^\s*OOM\b/i.test(e.message);
  // The `ReplyError` name is the strong signal; but a re-wrapped error may
  // lose `.name` while preserving the message, so a message that begins with
  // the exact OOM reply text is also accepted.
  const hasOomReplyText = /^\s*OOM command not allowed/i.test(e.message);
  return (isReplyError && startsWithOom) || hasOomReplyText;
}

/**
 * Operation/caller label vocabulary for the `redis_oom_degraded_total`
 * counter (issue #309). DELIBERATELY low-cardinality and closed-set — these
 * are code-path constants, NEVER raw tenant/agent IDs or keys (which would
 * explode Prometheus cardinality, same discipline as #286 / the
 * redis-memory-collector which is label-free). Per-tenant attribution flows
 * through the structured `redis.oom_degraded` log emitted alongside the
 * increment, not through metric labels.
 */
export type RedisOomCaller =
  | 'working_memory.push'
  | 'dedup.mark_seen'
  | 'dedup.backfill'
  | 'debouncer.write_state'
  | 'debouncer.clear_state'
  | 'vision_cache.set'
  | 'bot_detection.incr'
  | 'backpressure.acquire';

/**
 * Record a graceful OOM degradation for `caller` — increments the
 * low-cardinality `redis_oom_degraded_total{operation}` counter and emits a
 * structured warning. Centralised so every call site reports identically and
 * the label set can never drift into high-cardinality territory.
 *
 * `extra` carries per-tenant attribution (tenant_id/agent_id) into the LOG
 * only — it is never used as a metric label.
 */
export function recordRedisOomDegraded(
  caller: RedisOomCaller,
  extra?: Record<string, unknown>,
): void {
  incCounter('redis_oom_degraded_total', { operation: caller });
  logger.warn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
}

let connected = false;
redis.on('ready', () => {
  connected = true;
  logger.info('redis.ready');
});
redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'redis.error');
});
redis.on('end', () => {
  connected = false;
  logger.warn('redis.end');
});

export function isRedisConnected(): boolean {
  return connected;
}

export async function ensureRedisConnect(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connecting') return;
  try {
    await redis.connect();
  } catch (err) {
    logger.warn({ err }, 'redis.connect_failed');
  }
}
