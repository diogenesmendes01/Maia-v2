import { expireAuditModes } from '@/governance/audit-mode.js';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runAuditModeExpirer(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const expired = await expireAuditModes();
    if (expired > 0) logger.info({ expired }, 'audit_mode_expirer.done');
  });
}
