import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runInactivitySweep(): Promise<void> {
  // P0: single-tenant default. P6 will fan-out per tenant.
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    runInactivitySweepInner,
  );
}

async function runInactivitySweepInner(): Promise<void> {
  const result = await db.execute<{ id: string; pessoa_id: string }>(sql`
    UPDATE permissoes p
    SET status = 'suspensa'
    FROM pessoas ps
    WHERE p.pessoa_id = ps.id
      AND p.status = 'ativa'
      AND ps.tipo NOT IN ('dono','co_dono')
      AND NOT EXISTS (
        SELECT 1 FROM mensagens m
        JOIN conversas c ON m.conversa_id = c.id
        WHERE c.pessoa_id = p.pessoa_id AND m.created_at > now() - interval '60 days'
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
    logger.info({ count: result.rows.length }, 'inactivity_sweep.done');
  }
}
