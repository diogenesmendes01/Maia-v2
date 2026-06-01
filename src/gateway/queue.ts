import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { dlqRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { isRedisOomError, recordRedisOomDegraded } from '@/lib/redis.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
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
      // Issue #369: the worker callstack runs the channel resolver + cross-tenant
      // adoption (`src/agent/core.ts`) BEFORE the real tenant tuple is known, so
      // the job payload (`AgentJob = { mensagem_id }`) carries no tenant/agent to
      // open `runWithTenantContext` with here. Wrap the whole handler in the
      // sanctioned `system` ALS context so the pre-resolution window is NEVER
      // contextless — closing the fail-closed blind spot (`tenant-context.ts`
      // `MissingTenantContextError`) that blocked the #323 flip. Once the tenant
      // is resolved, `core.ts` opens a NESTED `runWithTenantContext({tenant_id,
      // agent_id})` that overrides this for the inner scope, so behaviour after
      // resolution is unchanged. The cross-tenant adoption helpers bypass the
      // tenant guard by design and the `'system'` sentinel is explicitly NOT
      // rejected by `assertNotDefaultLiteral`, so the outer context is inert for
      // them.
      await runWithSystemContext(() => processor(job));
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

/**
 * Signal that `enqueueAgent` could not arm the BullMQ job because Redis is at
 * its memory cap (#309 follow-up, PR #324 B1). Mirrors the debouncer's
 * `DebouncerRedisUnavailableError`: a raw ioredis `ReplyError` from
 * `agentQueue.add` must NOT escape and crash the dispatcher — it becomes a
 * typed, already-accounted signal the caller fail-closes on.
 *
 * Why a dedicated type (and not just re-throwing the ReplyError): the DLQ
 * path in `worker.on('failed')` only fires for jobs that already EXIST. An
 * OOM on `.add` happens BEFORE the job is created, so there is no job to DLQ.
 * The fail-closed contract is therefore "leave the inbound row PERSISTED
 * (processada_em IS NULL) and let `runMessageRecovery` re-enqueue it on the
 * next sweep" — never silently drop, never half-arm.
 */
export class QueueRedisUnavailableError extends Error {
  readonly code = 'QUEUE_REDIS_UNAVAILABLE';
  /** True when the underlying cause was a Redis OOM (capacity) rather than a
   *  connection-down condition — lets observability separate capacity
   *  incidents from connectivity ones. */
  readonly oom: boolean;
  constructor(opts?: { oom?: boolean }) {
    const cause = opts?.oom ? 'OOM (memory cap reached)' : 'unavailable';
    super(`enqueueAgent: Redis ${cause} during agentQueue.add; message left pending for recovery sweep`);
    this.name = 'QueueRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

/**
 * Enqueue an agent job for the non-debounced ingress path and the
 * message-recovery sweep.
 *
 * OOM handling (#309 follow-up, PR #324 B1): wrap `agentQueue.add` so a Redis
 * OOM `ReplyError` is converted to a typed `QueueRedisUnavailableError`
 * (FAIL-CLOSED). On OOM we record `redis_oom_degraded_total{operation:
 * 'enqueue_agent'}` and throw the typed error — we do NOT silently drop the
 * message and do NOT arm a half-state. The caller is responsible for leaving
 * the inbound row PERSISTED (it already is: `createInbound` writes
 * `processada_em: null`), so `runMessageRecovery` re-enqueues it once Redis
 * has headroom again. Non-OOM errors propagate UNCHANGED so a real Redis bug
 * (conn reset, failover, auth) still surfaces to the caller's observability.
 *
 * @throws QueueRedisUnavailableError on a Redis OOM (oom=true).
 * @throws the underlying error for any non-OOM failure.
 */
export async function enqueueAgent(data: AgentJob): Promise<void> {
  try {
    await agentQueue.add('process-message', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('enqueue_agent', { mensagem_id: data.mensagem_id });
      logger.warn(
        { mensagem_id: data.mensagem_id, redis_oom: true },
        'queue.enqueue_failed_oom_fail_closed',
      );
      throw new QueueRedisUnavailableError({ oom: true });
    }
    throw err;
  }
}

export async function shutdownQueue(): Promise<void> {
  await worker?.close();
  await agentQueue.close();
  await connection.quit();
}
