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

export async function checkAll(): Promise<{ status: HealthStatus; components: HealthReport[] }> {
  const reports = await Promise.all([checkDb(), checkRedis(), checkWhatsApp()]);
  const anyDown = reports.some((r) => r.status === 'down');
  const anyDeg = reports.some((r) => r.status === 'degraded');
  const overall: HealthStatus = anyDown ? 'down' : anyDeg ? 'degraded' : 'ok';
  for (const r of reports) {
    void healthRepo.record({
      component: r.component,
      status: r.status,
      duration_ms: r.latency_ms,
      error: r.details ? JSON.stringify(r.details) : undefined,
    });
  }
  return { status: overall, components: reports };
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
