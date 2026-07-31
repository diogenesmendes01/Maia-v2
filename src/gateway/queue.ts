import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import IORedis from 'ioredis';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { dlqRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { isRedisOomError, recordRedisOomDegraded } from '@/lib/redis.js';
import { runWithSystemContext } from '@/db/tenant-context.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import {
  correlationLogFields,
  deriveTraceId,
  runWithCorrelation,
} from '@/observability/correlation.js';
import { counter, histogram } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import { withCorrelation } from './job-correlation.js';
import {
  AGENT_TURN_JOB_VERSION,
  parseAgentJob,
  turnJobId,
  type ParsedAgentJob,
} from '@/runtime/turns/claim.js';
import type { AgentJob, AgentJobV1, AgentTurnJobV2 } from './types.js';

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const agentQueue = new Queue<AgentJob>('agent', { connection });

/**
 * How long a job deferred by the drain guard waits before becoming eligible
 * again. Long enough that THIS instance (which is going away) does not pick it
 * back up, short enough that the next instance answers the user quickly.
 */
const DRAIN_REQUEUE_DELAY_MS = 5_000;

/**
 * Refuse to START a job once the process stopped accepting work — issue #512
 * review round 1 (P1 on `src/index.ts:260`).
 *
 * `pauseQueueWorkers()` stops the workers from FETCHING, but there is an
 * unavoidable window: a fetch already in flight when the signal lands still
 * hands us a job. Without this guard that job would begin a full turn —
 * LLM call, tool writes, and an outbound send against a Baileys socket the
 * shutdown sequence may already have closed.
 *
 * The job is moved back to DELAYED instead of failed: no attempt is consumed,
 * no DLQ row is created, and the work stays recoverable for the next instance
 * (issue #512: "Jobs excedendo o deadline ficam recuperáveis"). `DelayedError`
 * is BullMQ's sanctioned way to tell the worker "I re-parked this job, do not
 * treat the handler's exit as a failure".
 */
async function deferIfNotAcceptingWork(
  job: Job<unknown>,
  token: string | undefined,
  queue: 'agent' | 'unrouted-replay',
): Promise<void> {
  if (lifecycle.isAcceptingWork()) return;
  await job.moveToDelayed(Date.now() + DRAIN_REQUEUE_DELAY_MS, token);
  incCounter('maia_queue_job_deferred_draining_total', { queue });
  logger.warn(
    { job_id: job.id, queue, lifecycle_state: lifecycle.state },
    'queue.job_deferred_draining',
  );
  throw new DelayedError();
}

let worker: Worker<AgentJob> | null = null;

/**
 * Registra o consumidor da fila `agent`.
 *
 * O processor recebe o payload JÁ INTERPRETADO (`ParsedAgentJob`) além do job
 * cru: assim a decisão "V1 ou V2" acontece UMA vez, aqui, e o entrypoint não
 * precisa reimplementar a leitura — o que seria a forma mais provável de as
 * duas divergirem durante a janela de rollout.
 */
export function startAgentWorker(
  processor: (job: Job<AgentJob>, parsed: ParsedAgentJob) => Promise<void>,
): Worker<AgentJob> {
  if (worker) return worker;
  worker = new Worker<AgentJob>(
    'agent',
    async (job, token) => {
      // Drain guard FIRST — before any side effect, before ANY context, and
      // before ANY turn metric (issue #512 + #514). Three reasons it must stay
      // ahead of the instrumentation below:
      //   1. a job the drain re-parks never STARTED a turn, so it must not
      //      appear in `maia_turn_started_total` or the latency histogram;
      //   2. `DelayedError` has to escape untouched so BullMQ treats the job as
      //      re-parked rather than failed — wrapping it in the outcome
      //      try/catch would record a phantom `retryable`;
      //   3. no attempt is consumed, so bumping the attempt counter would
      //      overstate retries during every deploy.
      await deferIfNotAcceptingWork(job, token, 'agent');

      // Issue #504 — LEITURA DUAL do payload. Um job V1 armado por um processo
      // antigo (deploy rolling) tem de processar normalmente; um payload que não
      // casa com nenhuma das versões é RECUSADO, porque executar "o que der" é
      // como um turno vira execução sem identidade.
      const parsed = parseAgentJob(job.data);
      if (!parsed) {
        incCounter('maia_turn_job_payload_total', { version: 'invalid' });
        logger.error({ job_id: job.id }, 'agent.job.unparseable_payload');
        throw new Error(
          `payload de job desconhecido (job_id=${job.id}): não casa com AgentTurnJobV2 nem com o formato legado`,
        );
      }
      incCounter('maia_turn_job_payload_total', {
        version: parsed.version === 2 ? 'v2' : 'v1',
      });
      const identity = parsed.version === 2 ? parsed.turn_id : parsed.mensagem_id;

      // Issue #514 §1 — restore the turn's root trace on the consumer side.
      // `attemptsMade` is 0 on the first pass, so `+1` yields a 1-based attempt
      // ordinal; a BullMQ retry of the SAME job keeps the trace id and bumps
      // the attempt, which is exactly the "recovery preserves root trace, new
      // attempt id" contract. Falling back to `deriveTraceId(identity)`
      // makes jobs armed before this deploy correlate identically.
      const trace_id = job.data.trace_id ?? deriveTraceId(identity);
      const attempt = (job.attemptsMade ?? 0) + 1;
      await runWithCorrelation(
        {
          trace_id,
          turn_id: identity,
          attempt,
          origin: 'queue',
          received_at_ms: job.data.received_at_ms ?? null,
          enqueued_at_ms: job.data.enqueued_at_ms ?? null,
        },
        async () => {
          // queue.wait — measured from the persisted arm timestamp, not from a
          // process-local clock, so it survives a worker restart.
          if (typeof job.data.enqueued_at_ms === 'number') {
            const waited = Date.now() - job.data.enqueued_at_ms;
            if (waited >= 0) histogram(METRIC.QUEUE_WAIT_MS, waited, { queue: 'agent' });
          }
          counter(METRIC.QUEUE_JOB_ATTEMPTS, {
            queue: 'agent',
            // Bounded label: first pass vs any retry. The exact ordinal stays
            // in the log/trace (taxonomy forbids unbounded numeric labels).
            phase: attempt === 1 ? 'first' : 'retry',
          });
          logger.debug(
            {
              job_id: job.id,
              job_version: parsed.version,
              turn_identity: identity,
              ...correlationLogFields(),
            },
            'agent.job.start',
          );
          counter(METRIC.TURN_STARTED, { origin: attempt === 1 ? 'queue' : 'recovery' });
          if (attempt > 1) counter(METRIC.TURN_RECOVERED, { queue: 'agent' });
          // Issue #369: the worker callstack runs the channel resolver + cross-tenant
          // adoption (`src/agent/core.ts`) BEFORE the real tenant tuple is known, so
          // the job payload carries no tenant/agent to open `runWithTenantContext`
          // with here. Wrap the whole handler in the sanctioned `system` ALS context
          // so the pre-resolution window is NEVER contextless — closing the
          // fail-closed blind spot (`tenant-context.ts` `MissingTenantContextError`)
          // that blocked the #323 flip. Once the tenant is resolved, `core.ts` opens a
          // NESTED `runWithTenantContext({tenant_id, agent_id})` that overrides this
          // for the inner scope, so behaviour after resolution is unchanged. The
          // cross-tenant adoption helpers bypass the tenant guard by design and the
          // `'system'` sentinel is explicitly NOT rejected by
          // `assertNotDefaultLiteral`, so the outer context is inert for them.
          //
          // Issue #514: the correlation ALS wraps this one. They are independent
          // stores — tenant context is fail-CLOSED (missing ⇒ throw), correlation is
          // fail-SOFT (missing ⇒ null) — so nesting cannot make one inherit the
          // other's semantics.
          //
          // Issue #514 §5 — turn outcome + latency are measured HERE rather than
          // inside `agent/core.ts` for two reasons: (a) this is the only place
          // that sees both the success and the throw for every turn, including
          // the ones that die before the core's own bookkeeping; (b) it keeps
          // the instrumentation off the files #503 is rewriting.
          const t0 = Date.now();
          try {
            await runWithSystemContext(() => processor(job, parsed));
            recordTurnOutcome(job, 'completed', t0);
          } catch (err) {
            // A turn that throws with retries left is RETRYABLE, not failed —
            // conflating the two would make the failure-rate SLI count every
            // transient blip as a lost turn.
            const exhausted = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 3);
            recordTurnOutcome(job, exhausted ? 'failed' : 'retryable', t0);
            throw err;
          }
        },
      );
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
  worker.on('failed', (job, err) => {
    logger.error({ job_id: job?.id, err: err?.message }, 'agent.job.failed');
    if (!job || job.attemptsMade < (job.opts.attempts ?? 3)) return;
    // Issue #512 review round 1 (P1 on the background-task registry): BullMQ
    // event listeners are fire-and-forget from the worker's point of view, so
    // `worker.close()` does NOT wait for them. This one WRITES — a DLQ row, an
    // audit row and an alert — and losing it during a deploy means a job
    // silently vanished with no DLQ trace. Tracked so the drain waits for it.
    void lifecycle.trackBackgroundTask(
      'dlq_write',
      (async () => {
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
      })().catch((e) => logger.error({ err: (e as Error).message }, 'agent.job.dlq_write_failed')),
    );
  });
  return worker;
}

/**
 * Issue #514 §5 — record a turn's terminal outcome and its two latencies.
 *
 * `maia_turn_duration_ms` is the PROCESS time (what this worker spent).
 * `maia_turn_e2e_latency_ms` is measured from the PERSISTED inbound timestamp
 * carried on the payload — that is the number the SLO is written against
 * ("Turn latency mede timestamps persistidos, não apenas duração do processo")
 * and it survives a worker restart, a debounce reset and a recovery re-arm.
 */
function recordTurnOutcome(
  job: Job<AgentJob>,
  outcome: 'completed' | 'retryable' | 'failed',
  startedAtMs: number,
): void {
  counter(METRIC.TURN_COMPLETED, { outcome, queue: 'agent' });
  histogram(METRIC.TURN_DURATION_MS, Date.now() - startedAtMs, { outcome });
  if (typeof job.data.received_at_ms === 'number') {
    const e2e = Date.now() - job.data.received_at_ms;
    if (e2e >= 0) histogram(METRIC.TURN_E2E_LATENCY_MS, e2e, { outcome });
  }
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
export async function enqueueAgent(data: AgentJobV1): Promise<void> {
  try {
    // Issue #514 §1 — stamp the correlation fields onto the payload. An
    // explicit `trace_id` from the caller always wins (the recovery sweep and
    // the unrouted replay both re-enqueue an existing turn); otherwise the id
    // is DERIVED from `mensagem_id`, so re-enqueueing the same row always
    // lands on the same root trace.
    await agentQueue.add('process-message', withCorrelation(data), {
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

/**
 * Arma (ou re-arma) o job V2 de um turno — issue #504.
 *
 * ## O que o `jobId` determinístico compra
 *
 * `turnJobId(turn_id)` é estável: o mesmo turno sempre mapeia para o mesmo id.
 * BullMQ recusa `add` de um id que já existe, então dois recoveries
 * concorrentes, um retry do ingresso e um replay manual convergem para UM job
 * ativo. A não-duplicação vira estrutural em vez de depender de quem chega
 * primeiro. E é só metade da garantia: o job é o DESPERTADOR, o claim atômico
 * é quem decide o executor.
 *
 * ## Jobs RETIDOS em estado final
 *
 * `removeOnComplete`/`removeOnFail` mantêm jobs concluídos por horas ou dias.
 * Enquanto a row existe no Redis, um `add` com o MESMO id é ignorado
 * silenciosamente — e um turno legitimamente rearmado (retry vencido, takeover
 * de lease, replay de dead letter) simplesmente nunca acordaria. É o cenário 4
 * da issue.
 *
 * A saída é remover a row RETIDA antes de rearmar, e só ela: `getState()`
 * distingue `completed`/`failed` (trabalho encerrado, a row é histórico) de
 * `waiting`/`active`/`delayed` (trabalho VIVO, que não pode ser tocado —
 * removê-lo seria cancelar um turno em andamento para "rearmá-lo"). Uma corrida
 * em que o job muda de estado entre a leitura e o remove resolve-se sozinha: o
 * `remove()` falha, e o `add` seguinte é ignorado porque o job vivo existe —
 * exatamente o resultado desejado.
 */
export async function enqueueAgentTurn(data: {
  turn_id: string;
  trace_id?: string;
  received_at_ms?: number;
  /** Atraso do wake-up, em ms — usado pelo backoff persistido. */
  delay_ms?: number;
}): Promise<{ armed: boolean; reason?: 'already_active' }> {
  const jobId = turnJobId(data.turn_id);
  const payload: AgentTurnJobV2 = withCorrelation({
    version: AGENT_TURN_JOB_VERSION,
    turn_id: data.turn_id,
    ...(data.trace_id !== undefined ? { trace_id: data.trace_id } : {}),
    ...(data.received_at_ms !== undefined ? { received_at_ms: data.received_at_ms } : {}),
  });

  try {
    const existing = await agentQueue.getJob(jobId).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => undefined);
        incCounter('maia_turn_job_rearm_total', { retained_state: state });
      } else {
        // Trabalho VIVO com este id: o wake-up já existe. Rearmar seria
        // duplicar — ou, pior, cancelar o job ativo.
        incCounter('maia_turn_job_rearm_total', { retained_state: 'alive' });
        return { armed: false, reason: 'already_active' };
      }
    }
    await agentQueue.add('process-message', payload, {
      jobId,
      ...(data.delay_ms !== undefined && data.delay_ms > 0 ? { delay: data.delay_ms } : {}),
      // Tentativas de TRANSPORTE. A tentativa CANÔNICA vive no PostgreSQL
      // (`agent_turns.attempt_count`, incrementado pelo claim): o BullMQ pode
      // reentregar, mas cada reentrega tem de vencer o claim de novo, então
      // nunca há duas tentativas ativas.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
    });
    return { armed: true };
  } catch (err) {
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('enqueue_agent_turn', { mensagem_id: data.turn_id });
      logger.warn({ turn_id: data.turn_id, redis_oom: true }, 'queue.enqueue_failed_oom_fail_closed');
      throw new QueueRedisUnavailableError({ oom: true });
    }
    throw err;
  }
}

/** Reexportado para que quem arma e quem inspeciona derivem o MESMO id. */
export { turnJobId };

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
    async (job, token) => {
      await deferIfNotAcceptingWork(job, token, 'unrouted-replay');
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
 * Stop CONSUMING, immediately — issue #512 review round 1 (P1 on
 * `src/index.ts:260`). This is the first atomic move of the shutdown, well
 * before anything is closed.
 *
 * `pause(true)` = stop fetching new jobs NOW and do NOT wait for the active
 * one; waiting is a separate, later step (`shutdownQueue()`). Splitting the
 * two is the whole point: the old sequence closed BullMQ in the FOURTH step,
 * after the WhatsApp sockets, so a job pulled meanwhile could reach an
 * outbound send with the transport already gone.
 *
 * Idempotent and safe on a process that never started the workers.
 */
export async function pauseQueueWorkers(): Promise<void> {
  await worker?.pause(true);
  await unroutedWorker?.pause(true);
  logger.info(
    { agent_paused: worker?.isPaused() ?? null, unrouted_paused: unroutedWorker?.isPaused() ?? null },
    'queue.workers_paused',
  );
}

/**
 * Wait until the BullMQ queues AND workers have a live Redis connection —
 * issue #512 review round 1 (P1 on `src/index.ts:170`).
 *
 * Constructing a `Queue`/`Worker` does NOT mean it can consume: the
 * connection is lazy. Marking the components `ready` right after construction
 * let `/readyz` answer 200 while BullMQ was still connecting, and with
 * `READINESS_BACKLOG_MAX=0` (the default) that flag is the ONLY evidence
 * readiness has about the queue.
 *
 * `waitUntilReady()` rejects if the connection cannot be established, so the
 * caller can fail the component closed.
 */
export async function awaitQueueReady(opts?: { includeWorkers?: boolean }): Promise<void> {
  await agentQueue.waitUntilReady();
  await unroutedQueue.waitUntilReady();
  if (opts?.includeWorkers === false) return;
  await worker?.waitUntilReady();
  await unroutedWorker?.waitUntilReady();
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
