/**
 * Issue #297 — Redis memory pressure metrics.
 *
 * PR #294 added `maxmemory 2gb` + `maxmemory-policy noeviction` to compose.
 * Under `noeviction` the cap turns memory pressure into *write failures*
 * (OOM errors from Redis) — invisible without instrumentation. The runbook
 * recommended alerts (see `docs/runbooks/redis.md` §4) but no collector
 * existed to feed them.
 *
 * This module periodically (default 15s) calls `INFO memory` + `INFO stats`
 * against the shared `ioredis` client, parses the relevant counters, and
 * exposes them as Prometheus gauges via the in-house metrics module
 * (`src/lib/metrics.ts` — pull-based gauges and a `/metrics` Fastify route).
 *
 * Metrics emitted (no labels — Redis-wide, cardinality discipline):
 *
 *   redis_used_memory_bytes           gauge  bytes Redis is using now
 *   redis_maxmemory_bytes             gauge  configured cap (0 = unbounded)
 *   redis_memory_used_ratio           gauge  used / max (0..1, NaN guarded)
 *   redis_evicted_keys_total          gauge  cumulative evictions
 *                                            (DEVE ficar em 0 sob noeviction —
 *                                             non-zero = config drift)
 *   redis_rejected_connections_total  gauge  cumulative rejected connections
 *                                            (mirrors Redis's monotonic
 *                                             counter; Prometheus `increase()`
 *                                             still produces the right delta)
 *
 * Failure modes:
 *  - Redis unreachable / error from `INFO` → cached values are NOT updated
 *    (gauges stay at last-known-good); we log a debounced warn but never
 *    throw. The connectivity gauge `maia_redis_connected` (server.ts) is the
 *    canonical "is Redis up" signal — these gauges going stale is the second
 *    symptom, not the primary alert.
 *  - First successful collect populates the cache; until then, gauges report
 *    0 (matches the "no observation yet" semantics, distinct from "max=0").
 *
 * Alert thresholds (see `docs/runbooks/redis.md` §4 for full Prometheus
 * rules + runbook reaction):
 *  - redis_memory_used_ratio > 0.80 → warning
 *  - redis_memory_used_ratio > 0.95 → critical (writes will fail soon)
 *  - redis_evicted_keys_total > 0   → critical (config drift under noeviction)
 *
 * Cardinality: zero labels by design. These are Redis-instance metrics; a
 * per-tenant breakdown would require Redis to expose per-key-prefix memory
 * accounting (it doesn't). Per-tenant memory attribution lives in working
 * memory / cache-layer counters elsewhere.
 */
import { redis } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { setGaugeProvider } from '@/lib/metrics.js';

export const DEFAULT_COLLECT_INTERVAL_MS = 15_000;

/** Last successful parse — used as the source of truth for gauge providers. */
interface MemorySnapshot {
  used_memory: number;
  maxmemory: number;
  evicted_keys: number;
  rejected_connections: number;
}

const snapshot: MemorySnapshot = {
  used_memory: 0,
  maxmemory: 0,
  evicted_keys: 0,
  rejected_connections: 0,
};

let gaugesRegistered = false;

/**
 * Parse a numeric field from a Redis INFO section payload.
 * INFO lines look like `used_memory:1572864`. Returns `undefined` if the
 * field is absent or non-numeric — callers decide whether to skip the
 * update or treat that as zero.
 */
export function parseInfoField(info: string, field: string): number | undefined {
  // Escape the field name for the regex; field names are static internal
  // constants but defense in depth is cheap and prevents a future caller
  // from accidentally injecting a regex metachar.
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchor at line start (^|\n) so a substring match in another field name
  // (e.g. `used_memory_rss` matching `used_memory`) doesn't trip us.
  const match = new RegExp(`(?:^|\\n)${escaped}:(\\d+)`).exec(info);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Register pull-based gauges that read from the cached snapshot. Idempotent —
 * registering twice would just overwrite the same provider, but the flag
 * keeps it cheap.
 */
function registerGauges(): void {
  if (gaugesRegistered) return;
  setGaugeProvider('redis_used_memory_bytes', () => snapshot.used_memory);
  setGaugeProvider('redis_maxmemory_bytes', () => snapshot.maxmemory);
  setGaugeProvider('redis_memory_used_ratio', () => {
    // maxmemory=0 means "unbounded" in Redis. Without a cap, the ratio is
    // undefined — emit 0 so alerts based on `> 0.80` never fire spuriously.
    // (The operator still sees `redis_maxmemory_bytes 0` which is the right
    // primary signal for "no cap configured".)
    if (snapshot.maxmemory <= 0) return 0;
    return snapshot.used_memory / snapshot.maxmemory;
  });
  setGaugeProvider('redis_evicted_keys_total', () => snapshot.evicted_keys);
  setGaugeProvider(
    'redis_rejected_connections_total',
    () => snapshot.rejected_connections,
  );
  gaugesRegistered = true;
}

/**
 * Run one collection cycle. Exported for tests — production callers go
 * through `startRedisMemoryCollector`.
 *
 * Two `INFO` calls (memory + stats) is intentional: combining into
 * `INFO memory stats` would work but the field positions are documented
 * per-section in the Redis docs, so a section-at-a-time call is easier to
 * reason about and mock.
 */
export async function collectOnce(): Promise<void> {
  try {
    const [memInfo, statsInfo] = await Promise.all([
      redis.info('memory'),
      redis.info('stats'),
    ]);

    const used = parseInfoField(memInfo, 'used_memory');
    const max = parseInfoField(memInfo, 'maxmemory');
    const evicted = parseInfoField(statsInfo, 'evicted_keys');
    const rejected = parseInfoField(statsInfo, 'rejected_connections');

    // Only overwrite fields we actually parsed — a partial INFO response
    // (unlikely but possible) shouldn't zero out a previously-good value.
    if (used !== undefined) snapshot.used_memory = used;
    if (max !== undefined) snapshot.maxmemory = max;
    if (evicted !== undefined) snapshot.evicted_keys = evicted;
    if (rejected !== undefined) snapshot.rejected_connections = rejected;
  } catch (err) {
    // Redis down or transient error — keep the previous snapshot (stale but
    // not misleadingly zero). The `maia_redis_connected` gauge is the
    // canonical "is Redis up" signal; this counter just notes that the
    // collector itself failed.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'redis.memory_collector.failed',
    );
  }
}

export interface CollectorHandle {
  /** Stops the periodic collection. Safe to call multiple times. */
  stop(): void;
}

/**
 * Boot the collector — register gauges, kick off an initial collection so
 * the first scrape after start is not zero, then run on a setInterval.
 *
 * Returns a handle whose `stop()` clears the interval. The timer is
 * `.unref()`'d so it does not keep the Node event loop alive on its own,
 * matching the existing `dbProbeTimer` pattern in `server.ts`.
 */
export function startRedisMemoryCollector(
  intervalMs: number = DEFAULT_COLLECT_INTERVAL_MS,
): CollectorHandle {
  registerGauges();

  // Kick off an initial collection — best-effort, so the first /metrics
  // scrape after boot reports real values instead of zeros. Catch any
  // rejection because we already log inside collectOnce.
  void collectOnce();

  const timer = setInterval(() => {
    void collectOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

/**
 * Reset all collector state. Tests only — never call in production.
 * Exported with the `_` prefix to match the convention in `metrics.ts`.
 */
export function _resetForTests(): void {
  snapshot.used_memory = 0;
  snapshot.maxmemory = 0;
  snapshot.evicted_keys = 0;
  snapshot.rejected_connections = 0;
  gaugesRegistered = false;
}
