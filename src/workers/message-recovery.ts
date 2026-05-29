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
 */
export async function runMessageRecovery(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    runMessageRecoveryInner,
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
