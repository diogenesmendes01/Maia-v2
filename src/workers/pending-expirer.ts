import { logger } from '@/lib/logger.js';
import { expireAll } from '@/workflows/pending-questions.js';
import { expireDueDualApprovals } from '@/workflows/dual-approval.js';

export async function runPendingExpirer(): Promise<void> {
  const { table } = await expireAll();
  const dualExpired = await expireDueDualApprovals();
  if (table > 0 || dualExpired > 0) {
    logger.info({ table, dualExpired }, 'pending_expirer.tick');
  }
}
