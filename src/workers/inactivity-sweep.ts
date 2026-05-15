import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

export async function runInactivitySweep(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant by enumerating
  // active (tenant_id, agent_id) tuples and invoking `runInactivitySweepInner`
  // inside `runWithTenantContext` once per tuple.
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    runInactivitySweepInner,
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
