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
  await startServer();
  startAgentWorker(async (job) => {
    await runAgentForMensagem(job.data.mensagem_id);
  });
  startWorkers(1);
  await startBaileys();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function shutdown() {
  logger.info('maia.shutting_down');
  stopWorkers();
  await audit({ acao: 'system_stopped' }).catch(() => undefined);
  await shutdownPools();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'maia.fatal');
  process.exit(1);
});
