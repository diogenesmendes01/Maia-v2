import { logger } from '@/lib/logger.js';
import { expireAll } from '@/workflows/pending-questions.js';
import { expireDueDualApprovals } from '@/workflows/dual-approval.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runPendingExpirer(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const { table } = await expireAll();
    const dualExpired = await expireDueDualApprovals();
    if (table > 0 || dualExpired > 0) {
      logger.info({ table, dualExpired }, 'pending_expirer.tick');
    }
  });
}
