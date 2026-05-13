import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { withTx } from '@/db/client.js';
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
 * Por execução stale (PR #85 fix P85-I1 — atomic pair):
 *   1. Registra event `auto_abandoned` em `procedure_execution_events` para
 *      preservar trilha de auditoria (event-sourced — a transição precisa
 *      ser reconstrutível do log de eventos).
 *   2. Atualiza a row: `status='abandoned'`, `outcome='no_response'`,
 *      `ended_at=now()`.
 *
 * Ambos passos ficam num único `withTx`. Crash entre eles antes da fix
 * deixava a row em `in_progress` com o event já gravado → o próximo tick
 * reabia a execução e emitia um segundo `auto_abandoned` event (audit
 * trail duplicado). Com a transação, ou ambos persistem ou nenhum
 * persiste — idempotência preservada.
 *
 * Itera por tenant (cross-tenant fan-out via `tenantsRepo.list()`) e abre
 * tenant context por iteração — garante que `procedureExecutionsRepo.
 * listStaleInProgress` filtre RLS-style por tenant. PR #85 fix P85-I6
 * limita o batch a `REAPER_BATCH_SIZE` (default 1000) por tenant por
 * tick: sem isso, depois de uma janela de outage, um único tick podia
 * sequencializar dezenas de milhares de writes e colidir com o tick
 * seguinte. O reaper é idempotente (modulo a transação acima), então o
 * backlog residual drena em ticks subsequentes — apenas com um teto de
 * trabalho por iteração.
 *
 * Spec line 594: "Worker reaper força status=abandoned após 7d de inatividade".
 */
const TTL_DAYS = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);
const BATCH_LIMIT = Number(process.env.REAPER_BATCH_SIZE ?? 1000);

export async function runProcedureExecutionReaper(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let reaped = 0;
  let batch_capped = false;

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const stale = await procedureExecutionsRepo.listStaleInProgress({
        ttl_days: TTL_DAYS,
        limit: BATCH_LIMIT,
      });

      if (stale.length >= BATCH_LIMIT) {
        batch_capped = true;
        logger.warn(
          { tenant_id: t.id, batch_size: stale.length, limit: BATCH_LIMIT },
          'procedure_execution_reaper.batch_capped',
        );
      }

      for (const ex of stale) {
        // P85-I1: atomic pair — event INSERT + status UPDATE in a single
        // transaction. If either fails or the process crashes, neither
        // persists and the next reaper tick handles the row cleanly.
        await withTx(async (tx) => {
          await procedureExecutionEventsRepo.recordTx(tx, {
            execution_id: ex.id,
            event_type: 'auto_abandoned',
            step_id: ex.current_step_id,
            payload: {
              reason: `inactive_for_${TTL_DAYS}_days`,
              last_activity_at: ex.last_activity_at,
            },
            confidence: null,
          } as any);

          await procedureExecutionsRepo.updateStateTx(tx, ex.id, {
            status: 'abandoned',
            outcome: 'no_response',
            ended_at: new Date(),
          });
        });

        reaped++;
      }
    });
  }

  logger.info(
    { reaped, ttl_days: TTL_DAYS, batch_limit: BATCH_LIMIT, batch_capped },
    'procedure_execution_reaper.done',
  );
}
