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
import {
  METRIC,
  SPAN,
  TURN_JOB_VERSION_VALUES,
  closedVocabulary,
} from '@/observability/taxonomy.js';
import {
  recordElapsedSpan,
  withSpan,
  type SpanAttribution,
} from '@/observability/tracer.js';
import {
  agentTurnJobId,
  jobVersionLabel,
  parseAgentTurnJob,
  type AgentTurnJobV2,
  type ParsedAgentTurnJob,
} from '@/runtime/turns/job.js';
import type { AgentJobFacts } from '@/runtime/turns/job-consumer.js';
import { withCorrelation } from './job-correlation.js';
import type { AgentJob } from './types.js';

/**
 * Issue #504 §Contrato do job — o que uma row da fila `agent` pode conter
 * DURANTE a janela de compatibilidade.
 *
 * A união é temporária por contrato: o produtor emite V2 quando
 * `FEATURE_TURN_JOB_V2` está ligada e o turno é conhecido, e V1 no resto dos
 * casos. Quem decide qual dos dois chegou é `parseAgentTurnJob`, uma vez só, no
 * topo do worker — nunca um `'mensagem_id' in job.data` espalhado.
 */
export type AgentQueuePayload = AgentJob | AgentTurnJobV2;

/**
 * O processor recebe o payload JÁ classificado. Passar `parsed` em vez de
 * deixar o consumidor reparsear é o que garante que a métrica de versão e a
 * decisão de despacho falem do MESMO parse: duas leituras independentes do
 * mesmo buffer são duas verdades que podem divergir sem que ninguém perceba.
 */
export type AgentJobProcessor = (
  job: Job<AgentQueuePayload>,
  parsed: ParsedAgentTurnJob,
  facts: AgentJobFacts,
) => Promise<void>;

/** Os campos que só existem no payload V1. `null` quando o job é V2/inválido. */
function legacyFields(parsed: ParsedAgentTurnJob, data: AgentQueuePayload): AgentJob | null {
  return parsed.kind === 'v1' ? (data as AgentJob) : null;
}

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export const agentQueue = new Queue<AgentQueuePayload>('agent', { connection });

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

let worker: Worker<AgentQueuePayload> | null = null;

export function startAgentWorker(processor: AgentJobProcessor): Worker<AgentQueuePayload> {
  if (worker) return worker;
  worker = new Worker<AgentQueuePayload>(
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

      // Issue #514 §1 — restore the turn's root trace on the consumer side.
      // `attemptsMade` is 0 on the first pass, so `+1` yields a 1-based attempt
      // ordinal; a BullMQ retry of the SAME job keeps the trace id and bumps
      // the attempt, which is exactly the "recovery preserves root trace, new
      // attempt id" contract. Falling back to `deriveTraceId(mensagem_id)`
      // makes jobs armed before this deploy correlate identically.

      // Issue #504 §Contrato do job — a LEITURA DUAL, no caminho real do
      // worker. Um parse só, no topo, ANTES de qualquer decisão: é ele que
      // classifica o payload, alimenta a métrica de versão e é entregue ao
      // processor. Fazê-lo aqui (e não dentro do consumidor) é o que mantém a
      // série `maia_turn_job_version_total` honesta mesmo quando o payload é
      // irreconhecível — nesse caso o consumidor lança, e uma métrica emitida
      // lá dentro nunca sairia.
      const parsed = parseAgentTurnJob(job.data);
      // Pela camada de POLÍTICA (`observability/metrics.ts::counter`), nunca
      // por `incCounter` cru — foi o que a #601 estabeleceu. A atribuição sai
      // `system` POR CONSTRUÇÃO: nada resolveu o tenant ainda, exatamente como
      // em `maia_queue_wait_ms` logo abaixo.
      counter(METRIC.TURN_JOB_VERSION, {
        version: closedVocabulary(jobVersionLabel(parsed), TURN_JOB_VERSION_VALUES),
      });
      const legacy = legacyFields(parsed, job.data);
      // Semente do `trace_id`: no V1 continua sendo o `mensagem_id` (byte a
      // byte o comportamento anterior). No V2 não há mensagem conhecida aqui,
      // então a janela pré-resolução usa o `turn_id` — e o consumidor
      // REANCORA a correlação no `mensagem_id` assim que o resolvedor a
      // devolve (`runtime/turns/job-consumer.ts`), para que o turno inteiro
      // fique num único trace.
      const seed =
        parsed.kind === 'v1'
          ? parsed.mensagem_id
          : parsed.kind === 'v2'
            ? parsed.turn_id
            : (job.id ?? 'unknown-job');
      const trace_id = legacy?.trace_id ?? deriveTraceId(seed);
      const attempt = (job.attemptsMade ?? 0) + 1;
      // Ver `AgentJobFacts`: o consumidor preenche `received_at_ms` no V2, e o
      // `recordTurnOutcome` abaixo o lê tanto no sucesso quanto no throw.
      const facts: AgentJobFacts = { received_at_ms: legacy?.received_at_ms ?? null };
      await runWithCorrelation(
        {
          trace_id,
          turn_id: parsed.kind === 'v2' ? parsed.turn_id : (legacy?.mensagem_id ?? null),
          attempt,
          origin: 'queue',
          received_at_ms: legacy?.received_at_ms ?? null,
          enqueued_at_ms: legacy?.enqueued_at_ms ?? null,
        },
        async () => {
          // queue.wait — measured from the persisted arm timestamp, not from a
          // process-local clock, so it survives a worker restart.
          //
          // The HISTOGRAM is recorded here, immediately: it is the queue-wait
          // SLI and it must survive a turn that never finishes. Its ALS
          // attribution is `system` by construction (nothing has resolved the
          // tenant yet) — see `docs/runbooks/observability-slo.md` §9.6.
          //
          // The SPAN is not. `enqueued_at_ms` describes a window that closed
          // before this worker existed, so there is no scope to read a tenant
          // from, and a span nobody can filter by tenant is the defect the
          // owner's review of PR #541 opened. It is therefore DEFERRED to the
          // `finally` below and stamped with the tuple the root `turn` span
          // actually resolved to. Deferring costs nothing structurally: the
          // start/end instants are explicit, and the span stays a SIBLING of
          // the turn (it is emitted with no span open, so `parent_span_id`
          // is null either way) because the waiting happened BEFORE the turn
          // started running.
          //
          // V2 não carrega `enqueued_at_ms` (o contrato do payload proíbe), e
          // por isso a amostra da espera é emitida pelo CONSUMIDOR a partir de
          // `agent_turns.queued_at` — já atribuída ao dono, que o worker aqui
          // não conhece.
          let queueWaitMs: number | null = null;
          if (typeof legacy?.enqueued_at_ms === 'number') {
            const waited = Date.now() - legacy.enqueued_at_ms;
            if (waited >= 0) {
              histogram(METRIC.QUEUE_WAIT_MS, waited, { queue: 'agent' });
              queueWaitMs = waited;
            }
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
              job_version: jobVersionLabel(parsed),
              ...(legacy ? { mensagem_id: legacy.mensagem_id } : {}),
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
          // Filled at the root span's close with the tuple the turn RESOLVED
          // to — never with the pre-resolution payload, which knows no tenant.
          // A plain box (not a bare `let`) so the closure write is visible to
          // the reader as the whole point of the variable. It is per-JOB: two
          // jobs of different tenants processing concurrently each get their
          // own, which is what keeps one tenant's tuple off another's span.
          const rootAttribution: { value: SpanAttribution | null } = { value: null };
          try {
            // Issue #535 — the ROOT operational span. It wraps the same scope
            // the turn metrics already measure, so span duration and
            // `maia_turn_duration_ms` can never disagree, and every span opened
            // deeper in the call stack (tool dispatch today, more later) lands
            // under it via ALS without threading a context object through the
            // hot path.
            await withSpan(SPAN.TURN, () => runWithSystemContext(() => processor(job, parsed, facts)), {
              attributes: { queue: 'agent', phase: attempt === 1 ? 'first' : 'retry' },
              onAttribution: (attribution) => {
                rootAttribution.value = attribution;
              },
            });
            recordTurnOutcome(job, 'completed', t0, facts);
          } catch (err) {
            // A turn that throws with retries left is RETRYABLE, not failed —
            // conflating the two would make the failure-rate SLI count every
            // transient blip as a lost turn.
            const exhausted = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 3);
            recordTurnOutcome(job, exhausted ? 'failed' : 'retryable', t0, facts);
            throw err;
          } finally {
            // The deferred `queue.wait` span (see above). Emitted on the throw
            // path too: a turn that failed still waited, and a backlog that
            // only shows up for successful turns understates itself exactly
            // when the queue is in trouble. `tenant_id`/`agent_id` are passed
            // EXPLICITLY because at this point the tenant scope has unwound —
            // caller-supplied attributes win over the tracer's own read.
            //
            // #504: `queueWaitMs` só é preenchido no ramo V1 (o payload V2 não
            // carrega `enqueued_at_ms`), então a guarda de tipo abaixo lê o
            // payload legado — no V2 o span simplesmente não é emitido, pela
            // mesma razão pela qual a histograma da espera migra para o
            // consumidor: aqui não existe instante de armação a reportar.
            const armedAtMs = legacy?.enqueued_at_ms;
            if (queueWaitMs !== null && typeof armedAtMs === 'number') {
              recordElapsedSpan(
                SPAN.QUEUE_WAIT,
                armedAtMs,
                armedAtMs + queueWaitMs,
                { queue: 'agent', ...(rootAttribution.value ?? {}) },
              );
            }
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
  job: Job<AgentQueuePayload>,
  outcome: 'completed' | 'retryable' | 'failed',
  startedAtMs: number,
  facts: AgentJobFacts,
): void {
  counter(METRIC.TURN_COMPLETED, { outcome, queue: 'agent' });
  histogram(METRIC.TURN_DURATION_MS, Date.now() - startedAtMs, { outcome });
  // #504: no V1 o relógio vem do payload; no V2 o consumidor o recompõe de
  // `mensagens.created_at` e o deposita em `facts` assim que resolve o escopo.
  // A caixa vence o payload porque um job V2 simplesmente não tem o campo — e
  // ler `job.data.received_at_ms` num payload V2 devolveria `undefined`,
  // apagando em silêncio o SLI ponta-a-ponta do caminho novo.
  const received_at_ms =
    facts.received_at_ms ?? ((job.data as AgentJob).received_at_ms ?? null);
  if (typeof received_at_ms === 'number') {
    const e2e = Date.now() - received_at_ms;
    if (e2e >= 0) histogram(METRIC.TURN_E2E_LATENCY_MS, e2e, { outcome });
  }
}

/**
 * Issue #504 — o preço do `jobId` determinístico, e como ele é pago.
 *
 * A BullMQ ignora `add` quando já existe um job com aquele id, e a retenção
 * desta fila mantém jobs `completed` por 24h e `failed` por 7 dias. Isso é o
 * que se quer enquanto o job está VIVO (waiting/active/delayed = "já tem
 * alguém cuidando disto"), e é um bloqueio ilegítimo depois que ele terminou:
 * um turno que voltou a ser elegível — retry com backoff vencido, replay manual
 * de dead letter, takeover de lease — não conseguiria ser rearmado até a
 * retenção expirar. É o risco que a própria issue lista ("Retenção da BullMQ
 * pode conflitar com jobId determinístico").
 *
 * A resolução é assimétrica de propósito:
 *   - job em estado TERMINAL (`completed`/`failed`): removido, o rearme segue;
 *   - job VIVO: intocado, e o `add` seguinte é ignorado pela BullMQ — que é
 *     exatamente a deduplicação desejada.
 *
 * Quem decide se o trabalho ainda vale continua sendo o PostgreSQL: aqui só se
 * remove o CADÁVER de um job para que o transporte não vete uma decisão que já
 * foi tomada no banco.
 *
 * Nunca lança: se a inspeção falhar, seguimos para o `add`. No pior caso o
 * `add` é ignorado e o sweep tenta de novo no próximo tick — perde-se latência
 * de recuperação, nunca correção.
 */
async function clearRetainedTurnJob(jobId: string): Promise<void> {
  try {
    const existing = await agentQueue.getJob(jobId);
    if (!existing) return;
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove();
    incCounter('maia_turn_job_retained_cleared_total', { state });
    logger.info({ job_id: jobId, state }, 'queue.turn_job_retained_cleared');
  } catch (err) {
    logger.warn(
      { job_id: jobId, err: (err as Error).message },
      'queue.turn_job_retained_clear_failed',
    );
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
export async function enqueueAgent(data: AgentJob): Promise<void> {
  try {
    // Issue #504 — `jobId` DETERMINÍSTICO quando o produtor conhece o turno.
    // Dois enfileiramentos do mesmo turno (ingresso + recovery, ou duas
    // réplicas do recovery) colidem no mesmo id e a BullMQ cria UM job.
    const jobId = data.turn_id ? agentTurnJobId(data.turn_id) : undefined;
    if (jobId) await clearRetainedTurnJob(jobId);
    // Issue #504 §Contrato do job, passo 5 do rollout — o PRODUTOR V2.
    //
    // Só quando a flag está ligada E o turno é conhecido. As duas condições são
    // necessárias: sem `turn_id` não há identidade durável a transportar, e um
    // V2 armado antes de todas as réplicas de consumo entenderem V2 seria um
    // job que nenhum worker antigo consegue processar (ele procuraria
    // `mensagem_id` e falharia). É por isso que a flag existe e nasce OFF — o
    // consumidor precede o produtor, sempre.
    //
    // O payload é EXATAMENTE `{version, turn_id}`. Nada de tenant, nada de
    // correlação, nada de conteúdo: o worker redescobre tudo no PostgreSQL,
    // depois de reconciliar o escopo. Carregar tenant aqui seria aceitar um
    // escopo que ninguém verificou contra a linha persistida.
    // Issue #514 §1 — stamp the correlation fields onto the payload. An
    // explicit `trace_id` from the caller always wins (the recovery sweep and
    // the unrouted replay both re-enqueue an existing turn); otherwise the id
    // is DERIVED from `mensagem_id`, so re-enqueueing the same row always
    // lands on the same root trace.
    const payload: AgentQueuePayload =
      config.FEATURE_TURN_JOB_V2 && data.turn_id
        ? { version: 2, turn_id: data.turn_id.toLowerCase() }
        : withCorrelation(data);
    await agentQueue.add('process-message', payload, {
      ...(jobId ? { jobId } : {}),
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
