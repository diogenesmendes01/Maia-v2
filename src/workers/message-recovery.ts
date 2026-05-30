import { mensagensRepo } from '@/db/repositories.js';
import { enqueueAgent, QueueRedisUnavailableError } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

const STUCK_AFTER_MS = 2 * 60 * 1000; // older than 2min and still unprocessed
const MAX_PER_RUN = 200;

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
  const tuples = await mensagensRepo.listTenantAgentPairsWithUnprocessedOlderThan(STUCK_AFTER_MS);

  if (tuples.length === 0) {
    logger.debug('message_recovery.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, runMessageRecoveryInner);
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

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'message_recovery.done',
  );
}

async function runMessageRecoveryInner(): Promise<void> {
  const stuck = await mensagensRepo.listUnprocessedOlderThan(STUCK_AFTER_MS, MAX_PER_RUN);
  if (stuck.length === 0) return;
  let requeued = 0;
  for (const m of stuck) {
    try {
      await enqueueAgent({ mensagem_id: m.id });
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
