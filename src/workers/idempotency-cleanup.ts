import { idempotencyRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { runWithSystemContext } from '@/db/tenant-context.js';

export async function runIdempotencyCleanup(): Promise<void> {
  // Genuinely-GLOBAL maintenance (issue #323 phase 2): `idempotencyRepo.cleanup`
  // is an explicitly-global sweep — it issues unconditioned DELETEs over
  // `idempotency_keys` (no tenant_id/agent_id predicate, never reads the ALS
  // context) and returns only a count, so it cannot leak and touches the same
  // rows under any context. Re-homed from the legacy `default/default` literal
  // to the reserved `system` sentinel.
  await runWithSystemContext(async () => {
    const removed = await idempotencyRepo.cleanup(30);
    logger.info({ removed }, 'idempotency_cleanup.done');
  });
}
