import type { FastifyInstance } from 'fastify';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { ensureRedisConnect } from '@/lib/redis.js';
import { startBaileys } from '@/gateway/baileys.js';
import { startAgentWorker } from '@/gateway/queue.js';
import { runAgentForMensagem } from '@/agent/core.js';
import { startServer } from '@/server.js';
import { audit } from '@/governance/audit.js';
import { shutdownPools } from '@/lib/healthcheck.js';
import { startWorkers, stopWorkers } from '@/workers/index.js';

async function main() {
  logger.info({ env: config.NODE_ENV, port: config.APP_PORT }, 'maia.starting');
  await audit({ acao: 'system_started' });

  await ensureRedisConnect();

  // B3b: clean up any orphan PDF reports from a prior crash. Best-effort.
  const { sweepPdfTmp } = await import('@/lib/pdf/_sweeper.js');
  await sweepPdfTmp().catch((err) => logger.warn({ err }, 'pdf.sweeper.boot_failed'));

  // SETUP: ensure bootstrap token exists (cold-start / first deploy).
  // Token NOT logged in plaintext — operator must SSH and read the file.
  const { ensureToken } = await import('@/setup/token.js');
  const { hasValidBaileysSession } = await import('@/setup/state.js');
  await ensureToken();
  if (!(await hasValidBaileysSession(config.BAILEYS_AUTH_DIR))) {
    logger.warn(
      { setup_token_path: '<BAILEYS_AUTH_DIR>/setup-token.txt' },
      'setup.bootstrap_token_ready — run `cat $BAILEYS_AUTH_DIR/setup-token.txt` and visit /setup',
    );
  }

  // P8e: cross-instance policy cache invalidation. Subscriber is idempotent.
  // Codex review #93: previously this was defined but never called,
  // leaving stale positive/negative cache entries until natural TTL.
  const { startPolicyCacheInvalidationSubscriber } = await import(
    '@/control-plane/policy/index.js'
  );
  startPolicyCacheInvalidationSubscriber();
  logger.info('policy_resolver.cache_invalidation_subscriber_started');

  const app = await startServer();
  startAgentWorker(async (job) => {
    await runAgentForMensagem(job.data.mensagem_id);
  });
  startWorkers(1);
  await startBaileys();

  // Fase 3 do roteamento multi-linha: sobe as sessões das linhas adicionais
  // (canais whatsapp ativos com auth pareado). No-op com MAIA_MULTI_LINE=false.
  const { startAdditionalLineSessions } = await import('@/gateway/line-sessions.js');
  await startAdditionalLineSessions().catch((err) =>
    logger.error({ err: (err as Error).message }, 'line_sessions.boot_failed'),
  );

  // Close over `app` so shutdown() can run Fastify's `onClose` hooks, which
  // stop the Redis memory-pressure collector + DB probe timers (server.ts).
  const shutdown = () => void gracefulShutdown(app);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function gracefulShutdown(app: FastifyInstance) {
  logger.info('maia.shutting_down');
  stopWorkers();
  const { shutdownLineSessions } = await import('@/gateway/line-sessions.js');
  await shutdownLineSessions().catch(() => undefined);
  // Closing the Fastify app fires its `onClose` hooks (collector/timer
  // cleanup) before we tear down the shared Redis/Postgres pools.
  await app.close().catch((err) => logger.warn({ err }, 'maia.app_close_failed'));
  await audit({ acao: 'system_stopped' }).catch(() => undefined);
  await shutdownPools();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'maia.fatal');
  process.exit(1);
});
