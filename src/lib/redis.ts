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
 * WRAPPED (Lua/EVAL) form — issue #333 / PR #339 review. When the OOM is
 * raised INSIDE a server-side script (e.g. the atomic `rpush`+`ltrim`+`expire`
 * EVAL in `src/memory/working.ts`), Redis does NOT surface the bare `OOM …`
 * reply. It wraps it in a script-runtime error whose reply text begins with
 * `ERR` and embeds the original message further along:
 *
 *   ReplyError: ERR Error running script (call to f_<sha>): @user_script:1:
 *   OOM command not allowed when used memory > 'maxmemory'.
 *
 * Here the leading token is `ERR`, not `OOM`, so the prefix-anchored checks
 * below do NOT fire. We therefore ALSO accept any message that CONTAINS the
 * substring `OOM command not allowed` anywhere in the reply. That exact phrase
 * is Redis' canonical OOM rejection text and is specific to a genuine
 * out-of-memory condition, so the substring match cannot false-positive on
 * lookalike words ("zoom", "room") the way a bare "oom" substring would.
 *
 * Detection is otherwise intentionally narrow: it matches the `OOM` reply
 * prefix (case-insensitive, token-anchored) and NOT any message that merely
 * contains the substring "oom" (e.g. "zoom", "room"). We anchor on the
 * leading token because Redis emits the error code as the first word of a
 * direct command reply; the substring branch above handles the wrapped
 * script-error form where `ERR` leads instead.
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
  // Wrapped/Lua form (#333/#339): an OOM raised inside an EVAL surfaces as
  // `ERR Error running script …: … OOM command not allowed …`, where `OOM` is
  // NOT the leading token. Match the canonical OOM phrase anywhere in the reply
  // — it is specific to a genuine out-of-memory rejection, so this does not
  // false-positive on "zoom"/"room".
  const containsOomReplyText = /OOM command not allowed/i.test(e.message);
  return (isReplyError && startsWithOom) || hasOomReplyText || containsOomReplyText;
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
  | 'backpressure.acquire'
  // Best-effort pace-key cleanup after a rate-limit deny in
  // `tryAcquireSendSlot` (#309 review, PR #324): the slot decision has
  // already been made, so an OOM here is recorded (attributed to the
  // cleanup site, not `backpressure.acquire`) but never throws.
  | 'backpressure.cleanup'
  // BullMQ enqueue path (#309 follow-up, PR #324 B1): an OOM on
  // `agentQueue.add` outside the debouncer (non-debounced ingress +
  // message-recovery sweep). Fail-closed — see `enqueueAgent` in
  // `src/gateway/queue.ts`.
  | 'enqueue_agent'
  // Rate-limit (#309 follow-up, PR #324 B2 / W1): the sliding-window zset
  // block and the overage get/set block now classify OOM explicitly while
  // preserving the intentional fail-closed `silence` posture.
  | 'rate_limit.zset'
  | 'rate_limit.overage';

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

/**
 * Operation/caller label vocabulary for the `redis_error_total` counter
 * (issue #309 follow-up, PR #324 B2). This is the NON-OOM sibling of
 * `redis_oom_degraded_total`: it surfaces a real Redis fault (connection
 * reset, failover, `READONLY`, `WRONGTYPE`, auth, etc.) at a site that
 * catches-all-but-must-not-crash, so the fault is observable instead of
 * silently absorbed by a fail-open/fail-closed branch.
 *
 * Same low-cardinality discipline as `RedisOomCaller`: these are code-path
 * constants, NEVER raw tenant/agent IDs or keys. Per-tenant attribution
 * flows through the structured `redis.error` log, not metric labels.
 *
 * NOTE: working-memory data-path errors keep their pre-existing
 * `working_memory_redis_error_total{op}` counter (see
 * `src/memory/working.ts`); this counter is for the catch-all sites that
 * had NO error metric before PR #324.
 */
export type RedisErrorCaller =
  | 'vision_cache.set'
  | 'bot_detection.incr'
  | 'rate_limit.zset'
  | 'rate_limit.overage'
  // Best-effort pace-key cleanup in `tryAcquireSendSlot` (#309 review, PR
  // #324): a non-OOM fault during the cleanup `DEL` is now metered+logged
  // instead of silently swallowed by `.catch(() => null)`. Stays
  // best-effort — the slot decision already happened, so it never throws.
  | 'backpressure.cleanup';

/**
 * Record a NON-OOM Redis error for `caller` — increments the low-cardinality
 * `redis_error_total{operation}` counter and emits a structured `redis.error`
 * warning. Centralised so every catch-all site reports identically.
 *
 * This does NOT change control flow: callers decide whether to fail-open,
 * fail-closed, or re-throw AFTER calling this. Its sole purpose is to make
 * the error visible (#309 follow-up, PR #324 B2): before this, a `READONLY`
 * or connection-reset at these sites was logged-without-metric (bot-detection,
 * vision-cache) or — for rate-limit — logged but never classified as OOM vs
 * not, so a capacity incident and a real bug looked identical.
 *
 * `extra` carries per-tenant attribution (tenant_id/agent_id) into the LOG
 * only — it is never used as a metric label.
 */
export function recordRedisError(
  caller: RedisErrorCaller,
  extra?: Record<string, unknown>,
): void {
  incCounter('redis_error_total', { operation: caller });
  logger.warn({ redis_error: true, caller, ...extra }, 'redis.error');
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
