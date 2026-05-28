import Fastify from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { checkAll, checkDb, checkRedis, checkWhatsApp } from '@/lib/healthcheck.js';
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
  // The timer self-`unref()`s so it never blocks process exit, matching
  // `dbProbeTimer` above; no explicit shutdown hook is required.
  startRedisMemoryCollector();

  app.get('/health', async () => checkAll());
  app.get('/health/db', async () => checkDb());
  app.get('/health/redis', async () => checkRedis());
  app.get('/health/whatsapp', async () => checkWhatsApp());
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
