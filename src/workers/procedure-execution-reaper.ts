import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { db, withTx } from '@/db/client.js';
import { procedure_executions } from '@/db/schema.js';
import {
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
 * Issue #323 (Phase 3) — per-agent fan-out, NÃO mais `agent_id:'default'`.
 *
 * BEFORE: o worker iterava `tenantsRepo.list()` e abria
 * `runWithTenantContext({ tenant_id, agent_id:'default' })` fixo. Como
 * `listStaleInProgress` filtrava SÓ por tenant_id (não agent), uma única
 * passada sob 'default' varria execuções de TODOS os agents do tenant — mas
 * o event `auto_abandoned` (via `applyTenantGuard`) era carimbado com
 * agent_id='default', mis-attribuindo a trilha de auditoria de cada agent
 * real. E no flip de `MAIA_REJECT_DEFAULT_LITERAL`, `getCurrentAgent()`
 * (chamado por `applyTenantGuard` no `recordTx`) lançaria. `tenantsRepo.list()`
 * ainda incluía `system`+`default`, que sob o flip também lançariam.
 *
 * AFTER: enumera tuplas (tenant_id, agent_id) DISTINCT que têm pelo menos uma
 * execução em `status='in_progress'` em `procedure_executions` (work-table
 * fan-out — mesmo padrão de reflection-batch/outbound-messages-sweeper,
 * #240/#251/#292). `listStaleInProgress` agora também filtra por agent_id, de
 * modo que cada iteração processa EXCLUSIVAMENTE as execuções stale daquele
 * agent e o event fica carimbado com o agent_id correto. `system`/`default`
 * não têm execuções seeded, então caem fora sem caso especial. Fail-isolated
 * por tupla.
 *
 * PR #85 fix P85-I6 limita o batch a `REAPER_BATCH_SIZE` (default 1000) por
 * (tenant, agent) por tick: sem isso, depois de uma janela de outage, um
 * único tick podia sequencializar dezenas de milhares de writes e colidir com
 * o tick seguinte. O reaper é idempotente (modulo a transação acima), então o
 * backlog residual drena em ticks subsequentes — apenas com um teto de
 * trabalho por iteração.
 *
 * Spec line 594: "Worker reaper força status=abandoned após 7d de inatividade".
 */
const TTL_DAYS = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);
const BATCH_LIMIT = Number(process.env.REAPER_BATCH_SIZE ?? 1000);

type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Issue #323 (Phase 3) — enumera tuplas (tenant_id, agent_id) DISTINCT com
 * pelo menos uma execução `in_progress`. Roda OUTSIDE de qualquer tenant
 * context — é o dispatcher. Só agents com execuções in_progress aparecem
 * (candidatos a serem stale); o filtro de TTL é aplicado depois, por tupla,
 * em `listStaleInProgress`. `system`/`default` não têm execuções seeded.
 *
 * Espelha o idioma `selectDistinct` de
 * `cognitiveCandidatesRepo.listPendingTenantPairsForType` (P83-C2). Usa o
 * índice `procedure_exec_tenant_agent_status_idx`.
 */
async function listAgentsWithInProgress(): Promise<TenantAgentRow[]> {
  return db
    .selectDistinct({
      tenant_id: procedure_executions.tenant_id,
      agent_id: procedure_executions.agent_id,
    })
    .from(procedure_executions)
    .where(eq(procedure_executions.status, 'in_progress'));
}

export async function runProcedureExecutionReaper(): Promise<void> {
  const tuples = await listAgentsWithInProgress();
  let reaped = 0;
  let batch_capped = false;
  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, async () => {
        const stale = await procedureExecutionsRepo.listStaleInProgress({
          ttl_days: TTL_DAYS,
          limit: BATCH_LIMIT,
        });

        if (stale.length >= BATCH_LIMIT) {
          batch_capped = true;
          logger.warn(
            { tenant_id, agent_id, batch_size: stale.length, limit: BATCH_LIMIT },
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
      agents_processed++;
    } catch (err) {
      // Fail-isolated por (tenant, agent): erro de um agent não interrompe o
      // loop — mirrors reflection-batch (#251) / outbound-messages-sweeper
      // (#292). Telemetria distingue via agents_failed/agents_processed.
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'procedure_execution_reaper.agent_failed',
      );
    }
  }

  logger.info(
    {
      tuples: tuples.length,
      agents_processed,
      agents_failed,
      reaped,
      ttl_days: TTL_DAYS,
      batch_limit: BATCH_LIMIT,
      batch_capped,
    },
    'procedure_execution_reaper.done',
  );
}
