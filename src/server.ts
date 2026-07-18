import Fastify from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import {
  checkAll,
  checkDb,
  checkReadiness,
  checkRedis,
  checkWhatsApp,
} from '@/lib/healthcheck.js';
import { renderPrometheus, setGaugeProvider } from '@/lib/metrics.js';
import { isRedisConnected } from '@/lib/redis.js';
import { isBaileysConnected } from '@/gateway/baileys.js';
import { isDbConnected, probeDb } from '@/db/client.js';
import { startRedisMemoryCollector } from '@/observability/redis-memory-collector.js';

export async function buildServer() {
  const app = Fastify({ logger: false });

  setGaugeProvider('maia_redis_connected', () => (isRedisConnected() ? 1 : 0));
  setGaugeProvider('maia_baileys_connected', () => (isBaileysConnected() ? 1 : 0));
  setGaugeProvider('maia_db_connected', () => (isDbConnected() ? 1 : 0));

  // Sonda sintética (spec §1.6) — sinal PRIMÁRIO de outage, DURÁVEL (lido de
  // synthetic_probe_state.last_ok_at, não in-memory): segundos desde o último
  // OK. Um valor que CRESCE É o outage e sobrevive a restart. Provider async,
  // sem ALS (scrape). Inerte (0) com a flag off / antes do primeiro OK.
  setGaugeProvider('synthetic_probe_seconds_since_last_ok', async () => {
    if (!config.MAIA_SYNTHETIC_PROBE) return 0;
    const { syntheticProbeRepo } = await import('@/db/repositories/synthetic-probe-repos.js');
    const { PROBE_TENANT_ID, PROBE_AGENT_ID } = await import('@/probe/constants.js');
    return syntheticProbeRepo.secondsSinceLastOk(PROBE_TENANT_ID, PROBE_AGENT_ID);
  });

  // Refresh the cached DB connectivity state in the background. Each call
  // self-throttles to 5s, so this is cheap regardless of the scrape rate.
  // Driven by setInterval so the gauge updates even when /metrics is idle.
  const dbProbeTimer = setInterval(() => {
    probeDb().catch(() => undefined);
  }, 5000);
  dbProbeTimer.unref?.();
  // Initial probe so the gauge is correct on the first scrape after boot.
  probeDb().catch(() => undefined);

  // Issue #297 — Redis memory pressure gauges (used_memory / maxmemory /
  // ratio / evicted_keys / rejected_connections). Periodic INFO collection
  // populates a snapshot that the gauge providers read on each scrape.
  // The timer self-`unref()`s so it never blocks a clean process exit, but
  // we still capture the handle and stop it on `onClose` so repeated
  // buildServer()/app.close() cycles (tests, hot reload) don't leak untracked
  // intervals — and `dbProbeTimer` is cleared there too for the same reason.
  const redisMemoryCollector = startRedisMemoryCollector();
  app.addHook('onClose', async () => {
    clearInterval(dbProbeTimer);
    redisMemoryCollector.stop();
  });

  app.get('/health', async () => checkAll());
  app.get('/health/db', async () => checkDb());
  app.get('/health/redis', async () => checkRedis());
  app.get('/health/whatsapp', async () => checkWhatsApp());
  // Issue #297 — readiness gate. Distinct from /health/* (liveness-ish
  // component probes): /readyz tells a load balancer whether to keep this
  // instance in rotation. Returns 503 when Redis memory pressure crosses the
  // critical ratio so the LB drains the instance BEFORE `noeviction` turns
  // pressure into write failures (see docs/runbooks/redis.md §4).
  app.get('/readyz', async (_req, reply) => {
    const report = await checkReadiness();
    reply.code(report.ready ? 200 : 503);
    return report;
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return renderPrometheus();
  });

  // Setup pairing routes — mounted always (no flag gate). See spec §4.5.
  const { registerSetupRoutes } = await import('@/setup/index.js');
  await registerSetupRoutes(app);

  return app;
}

export async function startServer() {
  const app = await buildServer();
  const address = await app.listen({ host: '0.0.0.0', port: config.APP_PORT });
  logger.info({ address }, 'http.listening');
  return app;
}
