import { Queue, Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
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
      // Bound failed-job retention for symmetry with `removeOnComplete` (#349).
      // Failed jobs were previously kept unbounded, so a DLQ pile could grow in
      // Redis until manual cleanup (and be mistaken for a working-memory leak in
      // an incident). The bound is generous (1000 jobs / 7d) so the operator
      // still has plenty of recent failed jobs to inspect via the DLQ.
      removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
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

// ─── §1.4 (spec roteamento v4) — replay de inbound NÃO-ROTEADO (strict) ────
//
// O job carrega SÓ o id da row (payload cifrado fica no Postgres). O jobId é
// ESTÁVEL (`unroutedReplayJobId(line, wid)`) para que commit + re-arm +
// recovery sweep sejam idempotentes — nunca dois jobs vivos para a mesma row.
//
// Política de retenção deliberada: `removeOnFail` imediato — a ROW pending é
// o registro durável (TTL 72h); um job que esgotou tentativas é removido para
// que o recovery sweep possa re-armar com o MESMO jobId no próximo tick
// (um failed retido bloquearia o re-add até a expiração da retenção).
export type UnroutedReplayJob = { unrouted_id: string };

export const unroutedQueue = new Queue<UnroutedReplayJob>('unrouted-replay', { connection });

let unroutedWorker: Worker<UnroutedReplayJob> | null = null;

export function startUnroutedReplayWorker(
  processor: (job: Job<UnroutedReplayJob>) => Promise<void>,
): Worker<UnroutedReplayJob> {
  if (unroutedWorker) return unroutedWorker;
  unroutedWorker = new Worker<UnroutedReplayJob>(
    'unrouted-replay',
    async (job) => {
      // Mesmo racional do agent worker (#369): a janela pré-resolução nunca
      // roda sem contexto — o replay resolve o tenant por dentro.
      await runWithSystemContext(() => processor(job));
    },
    {
      connection,
      concurrency: 1,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { count: 0 },
    },
  );
  unroutedWorker.on('failed', (job, err) => {
    logger.warn(
      { job_id: job?.id, err: err?.message },
      'unrouted_replay.job_failed_will_be_rearmed_by_sweep',
    );
  });
  return unroutedWorker;
}

/**
 * jobId ESTÁVEL e determinístico por (linha, wid) — a chave natural do
 * staging. BullMQ reserva ':' em custom ids (separador de keys no Redis;
 * hoje só uma exceção de compat deprecada deixa 3 segmentos passarem —
 * review PR #496 alto 2), então a identidade vira um digest: mesmo par ⇒
 * mesmo id, sem caractere reservado, sem depender do formato da linha/wid.
 */
export function unroutedReplayJobId(line_external_id: string, whatsapp_message_id: string): string {
  const digest = createHash('sha256')
    .update(`${line_external_id}:${whatsapp_message_id}`)
    .digest('hex');
  return `unrouted-${digest.slice(0, 40)}`;
}

/**
 * Arma (ou re-arma) o job de replay. Idempotente: BullMQ ignora o add quando
 * já existe job com o mesmo jobId — exatamente o contrato do §1.4 (conflito
 * no insert re-arma; sweep re-arma; nunca duplica).
 */
export async function enqueueUnroutedReplay(args: {
  unrouted_id: string;
  line_external_id: string;
  whatsapp_message_id: string;
}): Promise<void> {
  await unroutedQueue.add(
    'replay',
    { unrouted_id: args.unrouted_id },
    {
      jobId: unroutedReplayJobId(args.line_external_id, args.whatsapp_message_id),
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/**
 * Close the BullMQ surface in dependency order (issue #512 §5).
 *
 * `Worker.close()` waits for the job currently being processed to finish —
 * that wait IS the queue drain the old `gracefulShutdown()` never performed
 * (it closed the Redis/Postgres pools out from under an active turn). A job
 * that outlives the caller's deadline stays in Redis and is re-delivered as
 * stalled by the next instance, so unfinished work remains RECOVERABLE.
 *
 * Idempotent and safe on a process that never started the workers (a
 * role-restricted process, or a boot that failed before this point): the
 * connection is only quit when it is actually open.
 */
export async function shutdownQueue(): Promise<void> {
  await worker?.close();
  await unroutedWorker?.close();
  worker = null;
  unroutedWorker = null;
  await agentQueue.close().catch(() => undefined);
  await unroutedQueue.close().catch(() => undefined);
  if (connection.status !== 'end') await connection.quit().catch(() => undefined);
}
