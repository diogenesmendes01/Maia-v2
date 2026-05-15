import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  tenantsRepo,
  procedureExecutionsRepo,
  procedureExecutionEventsRepo,
} from '@/db/repositories.js';

/**
 * P3c Task 9 — `procedure-execution-reaper`.
 *
 * Worker periódico (cron `0 * * * *`) que força `status='abandoned'` em
 * execuções de procedimento cuja `last_activity_at` está mais antiga que
 * `PROCEDURE_TTL_DAYS` (default 7d) E ainda estão em `status='in_progress'`.
 *
 * Por execução stale:
 *   1. Registra event `auto_abandoned` em `procedure_execution_events` para
 *      preservar trilha de auditoria (event-sourced — a transição precisa
 *      ser reconstrutível do log de eventos).
 *   2. Atualiza a row: `status='abandoned'`, `outcome='no_response'`,
 *      `ended_at=now()`.
 *
 * Itera por tenant (cross-tenant fan-out via `tenantsRepo.list()`) e abre
 * tenant context por iteração — garante que `procedureExecutionsRepo.
 * listStaleInProgress` filtre RLS-style por tenant.
 *
 * Spec line 594: "Worker reaper força status=abandoned após 7d de inatividade".
 */
const TTL_DAYS = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);

export async function runProcedureExecutionReaper(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let reaped = 0;

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const stale = await procedureExecutionsRepo.listStaleInProgress({
        ttl_days: TTL_DAYS,
      });

      for (const ex of stale) {
        // Append auto_abandoned event FIRST (audit trail before mutation).
        await procedureExecutionEventsRepo.record({
          execution_id: ex.id,
          event_type: 'auto_abandoned',
          step_id: ex.current_step_id,
          payload: {
            reason: `inactive_for_${TTL_DAYS}_days`,
            last_activity_at: ex.last_activity_at,
          },
          confidence: null,
        } as any);

        // Then transition status. updateState bumps last_activity_at to now()
        // — irrelevante aqui porque a execução já está sendo encerrada.
        await procedureExecutionsRepo.updateState(ex.id, {
          status: 'abandoned',
          outcome: 'no_response',
          ended_at: new Date(),
        });

        reaped++;
      }
    });
  }

  logger.info({ reaped, ttl_days: TTL_DAYS }, 'procedure_execution_reaper.done');
}
