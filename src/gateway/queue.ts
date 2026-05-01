import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { dlqRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import type { AgentJob } from './types.js';

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const agentQueue = new Queue<AgentJob>('agent', { connection });

let worker: Worker<AgentJob> | null = null;

export function startAgentWorker(processor: (job: Job<AgentJob>) => Promise<void>): Worker<AgentJob> {
  if (worker) return worker;
  worker = new Worker<AgentJob>(
    'agent',
    async (job) => {
      logger.debug({ job_id: job.id, mensagem_id: job.data.mensagem_id }, 'agent.job.start');
      await processor(job);
    },
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 86_400 },
      // Failed jobs are kept by default — operator inspects via DLQ.
    },
  );
  worker.on('failed', async (job, err) => {
    logger.error({ job_id: job?.id, err: err?.message }, 'agent.job.failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      const entry = await dlqRepo.add({
        queue_name: 'agent',
        job_id: job.id ?? 'unknown',
        payload: job.data,
        error: err?.message ?? 'unknown',
        attempts: job.attemptsMade,
      });
      await audit({
        acao: 'dlq_job_added',
        alvo_id: entry.id,
        metadata: { queue: 'agent', job_id: job.id, attempts: job.attemptsMade },
      });
      await sendAlert({
        subject: `DLQ entry on agent queue (${job.attemptsMade} attempts)`,
        body: `Job ${job.id} exhausted retries. Error: ${err?.message ?? 'unknown'}\nDLQ id: ${entry.id}\nRun "npm run dlq" to inspect.`,
      }).catch(() => null);
    }
  });
  return worker;
}

export async function enqueueAgent(data: AgentJob): Promise<void> {
  await agentQueue.add('process-message', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

export async function shutdownQueue(): Promise<void> {
  await worker?.close();
  await agentQueue.close();
  await connection.quit();
}
