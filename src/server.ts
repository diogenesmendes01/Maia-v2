import Fastify from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { checkAll, checkDb, checkRedis, checkWhatsApp } from '@/lib/healthcheck.js';
import { registerDashboardRoutes } from '@/dashboard/index.js';

export async function buildServer() {
  const app = Fastify({ logger: false });

  app.get('/health', async () => checkAll());
  app.get('/health/db', async () => checkDb());
  app.get('/health/redis', async () => checkRedis());
  app.get('/health/whatsapp', async () => checkWhatsApp());

  await registerDashboardRoutes(app);

  return app;
}

export async function startServer() {
  const app = await buildServer();
  const address = await app.listen({ host: '0.0.0.0', port: config.APP_PORT });
  logger.info({ address }, 'http.listening');
  return app;
}
