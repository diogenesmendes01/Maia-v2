import { db, pool } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { redis, isRedisConnected } from '@/lib/redis.js';
import { isBaileysConnected, getLastDisconnectAt } from '@/gateway/baileys.js';
import { healthRepo } from '@/db/repositories.js';
import {
  CRITICAL_MEMORY_USED_RATIO,
  getMemoryUsedRatio,
  isMemorySnapshotFresh,
} from '@/observability/redis-memory-collector.js';

export type HealthStatus = 'ok' | 'degraded' | 'down';
export type HealthReport = {
  component: string;
  status: HealthStatus;
  latency_ms?: number;
  last_failure_at?: string;
  details?: Record<string, unknown>;
};

export async function checkDb(): Promise<HealthReport> {
  const t0 = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { component: 'db', status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    return { component: 'db', status: 'down', details: { err: (err as Error).message } };
  }
}

export async function checkRedis(): Promise<HealthReport> {
  const t0 = Date.now();
  try {
    if (!isRedisConnected()) return { component: 'redis', status: 'down' };
    await redis.ping();
    return { component: 'redis', status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    return { component: 'redis', status: 'down', details: { err: (err as Error).message } };
  }
}

export async function checkWhatsApp(): Promise<HealthReport> {
  if (isBaileysConnected()) return { component: 'whatsapp', status: 'ok' };
  const last = getLastDisconnectAt();
  return {
    component: 'whatsapp',
    status: 'down',
    last_failure_at: last?.toISOString(),
  };
}

/**
 * Aggregate component health. READ-ONLY as of issue #512.
 *
 * It used to fire three `healthRepo.record()` INSERTs on every call — and
 * `/health` is polled by the container healthcheck (compose.prod.yml) and by
 * every load balancer, so a probe endpoint grew `system_health_events`
 * forever and put write pressure on the DB during exactly the incidents it
 * was meant to observe. Historical persistence now lives in the
 * `health_monitor` cron worker (`src/workers/health-monitor.ts`), which calls
 * `recordHealthSnapshot()` once a minute.
 *
 * Result is cached for `HEALTH_CACHE_MS` so a thundering herd of probes
 * collapses into one round-trip per window.
 */
const HEALTH_CACHE_MS = 2_000;
let healthCache: { at: number; value: { status: HealthStatus; components: HealthReport[] } } | null =
  null;

export async function checkAll(): Promise<{ status: HealthStatus; components: HealthReport[] }> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return healthCache.value;
  const reports = await Promise.all([checkDb(), checkRedis(), checkWhatsApp()]);
  const anyDown = reports.some((r) => r.status === 'down');
  const anyDeg = reports.some((r) => r.status === 'degraded');
  const overall: HealthStatus = anyDown ? 'down' : anyDeg ? 'degraded' : 'ok';
  const value = { status: overall, components: reports };
  healthCache = { at: now, value };
  return value;
}

/**
 * Persist one health snapshot row per component. Called by the
 * `health_monitor` worker — NEVER by a probe endpoint (issue #512: "Probes de
 * load balancer não deveriam produzir writes ou crescimento de dados").
 */
export async function recordHealthSnapshot(components: HealthReport[]): Promise<void> {
  await Promise.all(
    components.map((r) =>
      healthRepo
        .record({
          component: r.component,
          status: r.status,
          duration_ms: r.latency_ms,
          error: r.details ? JSON.stringify(r.details) : undefined,
        })
        .catch(() => undefined),
    ),
  );
}

/**
 * Public projection of a health report. Strips `details`, which carries raw
 * driver text (`err.message` from pg/ioredis) and can leak connection strings,
 * hostnames and internal paths on an endpoint reachable by a load balancer
 * (issue #512: "Raw errors, secrets e paths internos não aparecem em health
 * público"). The full detail stays available to the worker and the logs.
 */
export function toPublicHealthReport(r: HealthReport): Omit<HealthReport, 'details'> {
  const { details: _details, ...safe } = r;
  return safe;
}

/** Test seam — drops the `/health` memoization. */
export function _resetHealthCacheForTests(): void {
  healthCache = null;
}

export type ReadinessReport = {
  ready: boolean;
  /** Why the instance is not ready, when `ready === false`. */
  reason?: string;
  checks: {
    redis_memory_used_ratio: number;
    redis_memory_critical_ratio: number;
    /**
     * Whether the collector has a recent successful Redis memory reading. When
     * false the ratio above is a zero-initialized / stale placeholder and the
     * gate fails closed (does not trust it).
     */
    redis_memory_snapshot_fresh: boolean;
  };
};

/**
 * Readiness gate for the load balancer (`/readyz`). Distinct from the
 * `/health/*` component probes: this answers "should the LB keep routing to
 * this instance?".
 *
 * Returns NOT-ready when Redis memory pressure crosses the critical ratio
 * (`> 0.95`). Under `maxmemory-policy noeviction` (see docs/runbooks/redis.md
 * §1) crossing the cap turns memory pressure into write failures (Redis OOM),
 * so draining the instance ahead of that point lets the LB shed load before
 * the incident cascades into BullMQ/idempotency/working-memory write errors.
 *
 * Fail-closed on an untrustworthy snapshot: the collector's cache is
 * zero-initialized and its first collect is not awaited, so before any
 * successful collect (cold start) — or after the collector has been failing
 * long enough to go stale — `getMemoryUsedRatio()` returns a placeholder 0
 * that does NOT mean "Redis is healthy/unbounded". A readiness gate meant to
 * shed load under memory pressure must not serve traffic on that unknown, so
 * we report NOT-ready until `isMemorySnapshotFresh()` confirms a recent real
 * reading. A genuine fresh `maxmemory=0` (unbounded Redis) is still fresh →
 * ratio 0 → ready; only the never-read / stale case drains.
 *
 * The ratio comes from the cached collector snapshot (no Redis round-trip),
 * so the probe stays cheap even under aggressive LB poll intervals.
 */
export async function checkReadiness(): Promise<ReadinessReport> {
  const ratio = getMemoryUsedRatio();
  const fresh = isMemorySnapshotFresh();
  const checks = {
    redis_memory_used_ratio: ratio,
    redis_memory_critical_ratio: CRITICAL_MEMORY_USED_RATIO,
    redis_memory_snapshot_fresh: fresh,
  };
  if (!fresh) {
    return {
      ready: false,
      reason:
        'redis memory snapshot unavailable: no fresh collector reading yet (cold start or stale) — failing closed until memory pressure is known',
      checks,
    };
  }
  if (ratio > CRITICAL_MEMORY_USED_RATIO) {
    return {
      ready: false,
      reason: `redis memory pressure critical: used_ratio ${ratio.toFixed(4)} > ${CRITICAL_MEMORY_USED_RATIO} (noeviction → writes will fail)`,
      checks,
    };
  }
  return { ready: true, checks };
}

export async function shutdownPools(): Promise<void> {
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
}
