import { idempotencyRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';

export async function runIdempotencyCleanup(): Promise<void> {
  const removed = await idempotencyRepo.cleanup(30);
  logger.info({ removed }, 'idempotency_cleanup.done');
}
