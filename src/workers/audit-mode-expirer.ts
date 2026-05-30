import { expireAuditModes } from '@/governance/audit-mode.js';
import { logger } from '@/lib/logger.js';
import { pessoasRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out.
 *
 * BEFORE: `runAuditModeExpirer` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * `expireAuditModes()` once. Since `expireAuditModes()` reads `pessoasRepo.list()`
 * (scoped to the ALS tenant/agent), only the `default` agent's people ever had
 * their expired audit mode cleared — real tenants' audit modes never expired.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that own at least one pessoa with
 * an expirable audit-mode pref (`pessoasRepo.listTenantAgentPairsWithExpiredAuditMode`,
 * a read over `pessoas`), then runs `expireAuditModes()` once PER tuple under
 * `runWithTenantContext`. The inner is unchanged — it re-derives the scope via
 * `pessoasRepo.list()`.
 *
 * Behavior-preserving in single-tenant mode: when the only data lives under
 * `('default','default')`, the enumeration yields exactly that one tuple, so the
 * inner still runs once under default. Fail-isolated per tuple (mirrors
 * reflection-batch #251 / outbound-messages-sweeper #292 / gap-escalation #337).
 */
export async function runAuditModeExpirer(): Promise<void> {
  const tuples = await pessoasRepo.listTenantAgentPairsWithExpiredAuditMode();

  if (tuples.length === 0) {
    logger.debug('audit_mode_expirer.idle');
    return;
  }

  let total_expired = 0;
  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      const expired = await runWithTenantContext(
        { tenant_id, agent_id },
        () => expireAuditModes(),
      );
      total_expired += expired;
      agents_processed++;
      if (expired > 0) logger.info({ tenant_id, agent_id, expired }, 'audit_mode_expirer.tenant_done');
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
        'audit_mode_expirer.agent_failed',
      );
    }
  }

  if (total_expired > 0 || agents_failed > 0) {
    logger.info(
      { tuples: tuples.length, agents_processed, agents_failed, expired: total_expired },
      'audit_mode_expirer.done',
    );
  }
}
