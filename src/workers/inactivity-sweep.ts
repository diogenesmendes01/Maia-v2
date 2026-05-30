import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { permissoesRepo } from '@/db/repositories.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out.
 *
 * BEFORE: `runInactivitySweep` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once, collapsing EVERY tenant's inactivity sweep onto the legacy
 * `default/default` bucket. Under a multi-tenant deployment that means only the
 * `default` agent's permissions were ever swept — real tenants' inactive
 * permissions were never suspended.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that могут own an inactive
 * non-owner permission (`permissoesRepo.listTenantAgentPairsWithInactiveCandidates`,
 * a read over the `permissoes`↔`pessoas` work set) and runs the existing inner
 * once PER tuple under `runWithTenantContext`. The inner is unchanged: it
 * already re-derives the scope via `getCurrentTenant()`/`getCurrentAgent()` and
 * filters every join + the NOT-EXISTS sub-query to that tuple.
 *
 * Behavior-preserving in single-tenant mode: when the only data lives under
 * `('default','default')`, the enumeration yields exactly that one tuple, so the
 * inner still runs once under default. In multi-tenant mode it fans out
 * correctly. Same pattern as reflection-batch (#240) / outbound-messages-sweeper
 * (#292) / gap-escalation-monitor (#337). Fail-isolated per tuple: an error in
 * one (tenant, agent) does not abort the others.
 */
export async function runInactivitySweep(): Promise<void> {
  const tuples = await permissoesRepo.listTenantAgentPairsWithInactiveCandidates();

  if (tuples.length === 0) {
    logger.debug('inactivity_sweep.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, runInactivitySweepInner);
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent): a failure in one scope must not
      // block the sweep of the others — mirrors reflection-batch (#251) /
      // outbound-messages-sweeper (#292).
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'inactivity_sweep.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'inactivity_sweep.done',
  );
}

async function runInactivitySweepInner(): Promise<void> {
  // CRITICAL: every table touched here (permissoes / pessoas / conversas /
  // mensagens) carries (tenant_id, agent_id). The raw SQL MUST scope every
  // join + the NOT-EXISTS subquery to the current context — otherwise a
  // sweep running under tenant A would mutate permissions of tenant B
  // ("Tenant isolation inviolable" — see project memory). Pre-PR-#81 the
  // UPDATE had no tenant predicate at all.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const result = await db.execute<{ id: string; pessoa_id: string }>(sql`
    UPDATE permissoes p
    SET status = 'suspensa'
    FROM pessoas ps
    WHERE p.pessoa_id = ps.id
      AND p.tenant_id = ${tenant_id}
      AND p.agent_id = ${agent_id}
      AND ps.tenant_id = ${tenant_id}
      AND ps.agent_id = ${agent_id}
      AND p.status = 'ativa'
      AND ps.tipo NOT IN ('dono','co_dono')
      AND NOT EXISTS (
        SELECT 1 FROM mensagens m
        JOIN conversas c ON m.conversa_id = c.id
        WHERE c.pessoa_id = p.pessoa_id
          AND m.tenant_id = ${tenant_id}
          AND m.agent_id = ${agent_id}
          AND c.tenant_id = ${tenant_id}
          AND c.agent_id = ${agent_id}
          AND m.created_at > now() - interval '60 days'
      )
    RETURNING p.id, p.pessoa_id
  `);
  for (const r of result.rows) {
    await audit({
      acao: 'permission_suspended_inactivity',
      alvo_id: (r as { id: string }).id,
      pessoa_id: (r as { pessoa_id: string }).pessoa_id,
    });
  }
  if (result.rows.length > 0) {
    logger.info({ count: result.rows.length, tenant_id, agent_id }, 'inactivity_sweep.done');
  }
}
