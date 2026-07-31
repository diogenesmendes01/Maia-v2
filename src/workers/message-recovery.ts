import { mensagensRepo, agentTurnsRepo } from '@/db/repositories.js';
import { enqueueAgent, QueueRedisUnavailableError } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  noteTurnQueued,
  reportLegacyProjectionDivergence,
  turnStateAuthoritative,
  turnStateMachineEnabled,
} from '@/runtime/turns/index.js';

const STUCK_AFTER_MS = 2 * 60 * 1000; // older than 2min and still unprocessed
const MAX_PER_RUN = 200;

/**
 * Issue #503 — o probe de divergência (§6, shadow-read) faz um JOIN de
 * `agent_turn_inputs × agent_turns × mensagens` por par. Barato hoje, caro numa
 * base grande — e ele mede uma condição que muda em MINUTOS, não a cada sweep.
 * Por isso roda no máximo uma vez a cada 15min por processo, e nunca no caminho
 * que rearma trabalho.
 */
const DIVERGENCE_PROBE_EVERY_MS = 15 * 60 * 1000;
let lastDivergenceProbeAt = 0;

/**
 * Shadow-read (#503 §6, passo 6): mede a divergência entre a máquina de estados
 * e a projeção legada, SEM decidir nada com ela. É o sinal que autoriza (ou
 * barra) ligar `FEATURE_TURN_STATE_AUTHORITATIVE`.
 *
 * INDEPENDENTE da fila de recovery, e roda mesmo quando o sweep está idle: a
 * divergência que mais importa (turno `retryable` com `processada_em`
 * preenchido) vive exatamente nos pares SEM trabalho pendente — o campo legado
 * carimbado é o que os esconde da enumeração. Amarrar o probe à fila era
 * garantir que a métrica central nunca saísse.
 *
 * Throttled (15min/processo) porque a query é um JOIN de três tabelas e mede
 * uma condição que muda em minutos, não a cada tick. Nunca lança.
 */
async function runDivergenceProbe(): Promise<void> {
  if (!turnStateMachineEnabled()) return;
  if (Date.now() - lastDivergenceProbeAt < DIVERGENCE_PROBE_EVERY_MS) return;
  lastDivergenceProbeAt = Date.now();
  try {
    const report = await reportLegacyProjectionDivergence();
    if (report && report.pairs > 0) {
      logger.warn(
        {
          pairs: report.pairs,
          terminal_without_projection: report.terminal_without_projection,
          projection_without_terminal: report.projection_without_terminal,
        },
        'message_recovery.divergence_detected',
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'message_recovery.divergence_probe_failed',
    );
  }
}

/**
 * Re-enqueues inbound messages that were persisted but never picked up by the
 * agent worker (process killed between insert and enqueue, or BullMQ outage).
 * Idempotent: agent-core early-returns when processada_em is set.
 *
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out.
 *
 * BEFORE: `runMessageRecovery` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once. `mensagensRepo.listUnprocessedOlderThan` resolves the ALS
 * tenant/agent, so under multi-tenant ONLY the `default` agent's stranded
 * inbound messages were ever re-enqueued — real tenants' stuck messages were
 * never recovered.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context —
 * the DISTINCT (tenant_id, agent_id) tuples that own at least one stuck inbound
 * message (`mensagensRepo.listTenantAgentPairsWithUnprocessedOlderThan`, whose
 * predicate mirrors the inner's filter EXACTLY), then runs the inner once PER
 * tuple inside `runWithTenantContext`.
 *
 * Inner read/write scoping (audited per #345 "scope the inner" lesson):
 *   - READ: `mensagensRepo.listUnprocessedOlderThan` already binds the ALS
 *     `tenant_id` AND `agent_id` in its WHERE (see repositories.ts) — so each
 *     pass reads ONLY the current tuple's stranded messages. No change needed.
 *   - WRITE: there is none. `enqueueAgent({ mensagem_id })` only pushes the
 *     message id onto the queue; the row is never mutated here (the worker has
 *     no `marcarProcessada` capability — fail-closed for the next sweep).
 *
 * Behavior-preserving in single-tenant mode: when the only stuck data lives
 * under `('default','default')`, the enumeration yields exactly that one tuple,
 * so the inner still runs once under default. Fail-isolated per tuple.
 */
export async function runMessageRecovery(): Promise<void> {
  // Issue #503, passo 8 do rollout. Duas fontes de verdade possíveis para
  // "quem precisa ser rearmado":
  //   OFF (padrão): `processada_em IS NULL` — comportamento histórico. A
  //     máquina de estados roda em SHADOW e só medimos a divergência.
  //   ON: `agent_turns.status` — o único modo em que `retryable` volta à fila e
  //     em que `outbound_pending`/`ignored`/`superseded`/`dead_letter` são
  //     EXPLICITAMENTE poupados (o filtro legado não sabe distingui-los).
  const authoritative = turnStateAuthoritative();
  const tuples = authoritative
    ? await agentTurnsRepo.listTenantAgentPairsWithRecoverableTurns(STUCK_AFTER_MS)
    : await mensagensRepo.listTenantAgentPairsWithUnprocessedOlderThan(STUCK_AFTER_MS);

  if (tuples.length === 0) {
    // O probe roda ANTES do retorno idle. Ele NÃO depende da fila: a
    // divergência central da issue (turno `retryable` com `processada_em`
    // preenchido) aparece justamente em pares SEM trabalho pendente — o campo
    // legado carimbado é o que os esconde da enumeração de recovery.
    await runDivergenceProbe();
    logger.debug('message_recovery.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext(
        { tenant_id, agent_id },
        authoritative ? runTurnRecoveryInner : runMessageRecoveryInner,
      );
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a throw under one tuple must not
      // abort recovery for the others.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'message_recovery.agent_failed',
      );
    }
  }

  await runDivergenceProbe();

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed, authoritative },
    'message_recovery.done',
  );
}

/**
 * Inner do modo AUTORITATIVO (#503): elege candidatos POR ESTADO do turno.
 *
 * Diferenças materiais em relação ao inner legado:
 *   - `retryable` volta à fila quando `next_attempt_at` vence — o legado nunca
 *     rearmava um turno cujo `processada_em` já tinha sido carimbado;
 *   - `outbound_pending` NUNCA é rearmado (a resposta já está comprometida; só
 *     o delivery worker de #506 a finaliza);
 *   - terminais (`completed`/`ignored`/`superseded`/`dead_letter`) são
 *     invisíveis por construção.
 *
 * O job continua carregando só `mensagem_id` (a representativa do turno): o
 * worker do agente reencontra o turno por `findTurnByMessage`. jobId
 * determinístico — e portanto a garantia de não duplicar execução — é #504.
 */
async function runTurnRecoveryInner(): Promise<void> {
  const candidates = await agentTurnsRepo.findRecoverableTurns(STUCK_AFTER_MS, MAX_PER_RUN);
  if (candidates.length === 0) return;
  let requeued = 0;
  for (const { turn, reason } of candidates) {
    incCounter('maia_turn_recovery_candidates_total', { reason });
    try {
      await enqueueAgent({ mensagem_id: turn.representative_message_id });
      // Só `received` e `retryable` têm aresta para `queued`. Um turno já em
      // `queued` (job perdido) ou em `claimed`/`running` com lease vencida é
      // rearmado na FILA sem mexer no estado — tentar transicionar aqui só
      // produziria conflito de CAS ruidoso, e rebaixar `running` para `queued`
      // seria mentira sobre o que já foi executado.
      if (turn.status === 'received' || turn.status === 'retryable') {
        await noteTurnQueued({
          turn_id: turn.id,
          status: turn.status,
          state_version: Number(turn.state_version),
          attempt_count: turn.attempt_count,
          conversa_id: turn.conversa_id,
        });
      }
      requeued++;
    } catch (err) {
      if (err instanceof QueueRedisUnavailableError) {
        logger.warn(
          { turn_id: turn.id, requeued, scanned: candidates.length, oom: err.oom },
          'turn_recovery.aborted_redis_unavailable',
        );
        break;
      }
      logger.warn(
        { err: (err as Error).message, turn_id: turn.id, reason },
        'turn_recovery.enqueue_failed',
      );
    }
  }
  logger.info({ requeued, scanned: candidates.length }, 'turn_recovery.done');
}

async function runMessageRecoveryInner(): Promise<void> {
  const stuck = await mensagensRepo.listUnprocessedOlderThan(STUCK_AFTER_MS, MAX_PER_RUN);
  if (stuck.length === 0) return;
  let requeued = 0;
  for (const m of stuck) {
    try {
      // Issue #514 §5 — recovery keeps the ORIGINAL arrival timestamp so a
      // recovered turn's E2E latency reflects the real user-visible delay
      // (that is the point of the SLI) instead of restarting the clock.
      await enqueueAgent({ mensagem_id: m.id, received_at_ms: m.created_at?.getTime() });
      requeued++;
    } catch (err) {
      // FAIL-CLOSED (#309 follow-up, PR #324 B1): the row is left UNPROCESSED
      // (we never call `marcarProcessada`), so the NEXT sweep retries it — no
      // message is lost or marked done on a failed enqueue.
      if (err instanceof QueueRedisUnavailableError) {
        // Redis OOM: `enqueueAgent` already recorded
        // `redis_oom_degraded_total{operation="enqueue_agent"}`. Stop the
        // sweep early — hammering a memory-capped Redis with the remaining
        // rows would only emit more OOMs; they stay pending for the next run.
        logger.warn(
          { mensagem_id: m.id, requeued, scanned: stuck.length, oom: err.oom },
          'message_recovery.aborted_redis_unavailable',
        );
        break;
      }
      // Non-OOM (conn reset, failover, auth, etc.): keep it VISIBLE per
      // message and continue with the rest of the batch (a single poison row
      // shouldn't stall recovery of the others). `enqueueAgent` re-threw the
      // raw error untouched, so the message text is preserved here.
      logger.warn(
        { err: (err as Error).message, err_code: (err as { code?: string }).code, mensagem_id: m.id },
        'message_recovery.enqueue_failed',
      );
    }
  }
  logger.info({ requeued, scanned: stuck.length }, 'message_recovery.done');
}
