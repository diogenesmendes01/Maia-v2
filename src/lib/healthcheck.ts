import { db, pool } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { redis, isRedisConnected } from '@/lib/redis.js';
import { isBaileysConnected, getLastDisconnectAt } from '@/gateway/baileys.js';
import { healthRepo } from '@/db/repositories.js';

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

export async function shutdownPools(): Promise<void> {
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
}
