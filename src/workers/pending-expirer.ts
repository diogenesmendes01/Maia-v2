import { logger } from '@/lib/logger.js';
import { expireAll } from '@/workflows/pending-questions.js';
import { expireDueDualApprovals } from '@/workflows/dual-approval.js';
import { pendingQuestionsRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out.
 *
 * BEFORE: `runPendingExpirer` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once. `expireDueDualApprovals()` reads `workflowsRepo.listPending()`
 * (scoped to the ALS tenant/agent), so under multi-tenant only the `default`
 * agent's dual-approvals ever timed out — real tenants' expired approvals were
 * never cancelled and their requesters never notified.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that have EITHER a due
 * `pending_questions` row OR a due `dual_approval` workflow
 * (`pendingQuestionsRepo.listTenantAgentPairsWithDueExpirations`, the UNION of
 * both work tables), then runs the existing inner once PER tuple under
 * `runWithTenantContext`. The inner is unchanged — both `expireAll()` and
 * `expireDueDualApprovals()` already operate under the ALS scope.
 *
 * Behavior-preserving in single-tenant mode: when the only data lives under
 * `('default','default')`, the enumeration yields exactly that one tuple, so the
 * inner still runs once under default. Fail-isolated per tuple (mirrors
 * reflection-batch #251 / outbound-messages-sweeper #292 / gap-escalation #337).
 */
export async function runPendingExpirer(): Promise<void> {
  const tuples = await pendingQuestionsRepo.listTenantAgentPairsWithDueExpirations();

  if (tuples.length === 0) {
    logger.debug('pending_expirer.idle');
    return;
  }

  let total_table = 0;
  let total_dual = 0;
  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      const { table, dualExpired } = await runWithTenantContext(
        { tenant_id, agent_id },
        async () => {
          const { table } = await expireAll();
          const dualExpired = await expireDueDualApprovals();
          return { table, dualExpired };
        },
      );
      total_table += table;
      total_dual += dualExpired;
      agents_processed++;
      if (table > 0 || dualExpired > 0) {
        logger.info({ tenant_id, agent_id, table, dualExpired }, 'pending_expirer.tick');
      }
    } catch (err) {
      // Fail-isolated per (tenant, agent).
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'pending_expirer.agent_failed',
      );
    }
  }

  if (total_table > 0 || total_dual > 0 || agents_failed > 0) {
    logger.info(
      {
        tuples: tuples.length,
        agents_processed,
        agents_failed,
        table: total_table,
        dualExpired: total_dual,
      },
      'pending_expirer.done',
    );
  }
}
