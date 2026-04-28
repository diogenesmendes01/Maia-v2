import { mensagensRepo } from '@/db/repositories.js';
import { enqueueAgent } from '@/gateway/queue.js';
import { logger } from '@/lib/logger.js';

const STUCK_AFTER_MS = 2 * 60 * 1000; // older than 2min and still unprocessed
const MAX_PER_RUN = 200;

/**
 * Re-enqueues inbound messages that were persisted but never picked up by the
 * agent worker (process killed between insert and enqueue, or BullMQ outage).
 * Idempotent: agent-core early-returns when processada_em is set.
 */
export async function runMessageRecovery(): Promise<void> {
  const stuck = await mensagensRepo.listUnprocessedOlderThan(STUCK_AFTER_MS, MAX_PER_RUN);
  if (stuck.length === 0) return;
  let requeued = 0;
  for (const m of stuck) {
    try {
      await enqueueAgent({ mensagem_id: m.id });
      requeued++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, mensagem_id: m.id }, 'message_recovery.enqueue_failed');
    }
  }
  logger.info({ requeued, scanned: stuck.length }, 'message_recovery.done');
}
