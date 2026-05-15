import { idempotencyRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runIdempotencyCleanup(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const removed = await idempotencyRepo.cleanup(30);
    logger.info({ removed }, 'idempotency_cleanup.done');
  });
}
