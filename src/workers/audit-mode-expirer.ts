import { expireAuditModes } from '@/governance/audit-mode.js';
import { logger } from '@/lib/logger.js';

export async function runAuditModeExpirer(): Promise<void> {
  const expired = await expireAuditModes();
  if (expired > 0) logger.info({ expired }, 'audit_mode_expirer.done');
}
