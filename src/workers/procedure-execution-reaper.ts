import { and, eq, lt, sql } from 'drizzle-orm';
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
 * Issue #323 (Phase 3) review (NON-BLOCKING): com o fan-out per-agent, o cap
 * `REAPER_BATCH_SIZE` passou a valer POR tupla (tenant, agent), então o custo
 * por tick cresce com a contagem de tuplas — não mais um teto fixo como em
 * P85-I6. Para reintroduzir um limite GLOBAL por tick, há um orçamento
 * cumulativo `REAPER_GLOBAL_BUDGET` (default 5000) através de TODAS as tuplas:
 * assim que o total de execuções ceifadas no tick atinge o orçamento, o loop
 * de tuplas para. O orçamento é o teto global; `REAPER_BATCH_SIZE` continua
 * sendo o teto de read POR tupla.
 *
 * Issue #323 (Phase 3) review iteration-2 (BLOCKING — fairness/starvation): o
 * orçamento global limita os writes por tick, mas a enumeração de tuplas
 * precisa de uma ordem JUSTA — senão o loop sempre começa pela cabeça da lista
 * e dá break quando o orçamento estoura, de modo que as MESMAS tuplas no topo
 * consomem o orçamento todo tick e as de baixo passam fome indefinidamente.
 * FIX (stateless, auto-corretivo): a enumeração agora ordena as tuplas pela
 * execução stale MAIS ANTIGA de cada uma, ascendente — `(tenant_id, agent_id,
 * MIN(last_activity_at) AS oldest)` sobre as rows stale `in_progress`
 * (`last_activity_at < now() - ttl`), `GROUP BY tenant_id, agent_id ORDER BY
 * oldest ASC`. Processa-se nessa ordem até o orçamento global esgotar. Como as
 * execuções de uma tupla faminta só envelhecem, ela sobe para o topo nos ticks
 * seguintes — garantindo progresso eventual de TODAS as tuplas (sem
 * starvation). A enumeração também já aplica o cutoff de TTL, então tuplas com
 * apenas execuções frescas nem aparecem (menos trabalho que o
 * `selectDistinct` anterior, que enumerava qualquer tupla com in_progress).
 *
 * Spec line 594: "Worker reaper força status=abandoned após 7d de inatividade".
 */
const TTL_DAYS = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);
const BATCH_LIMIT = Number(process.env.REAPER_BATCH_SIZE ?? 1000);
// Issue #323 (Phase 3): global per-tick budget across ALL (tenant, agent)
// tuples, restoring the bounded per-tick cost P85-I6 provided before the
// per-agent fan-out turned BATCH_LIMIT into a per-tuple cap. Idempotent —
// leftover backlog drains on later ticks.
const GLOBAL_BUDGET = Number(process.env.REAPER_GLOBAL_BUDGET ?? 5000);

type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Issue #323 (Phase 3) review iteration-2 (BLOCKING — fairness) — enumera as
 * tuplas (tenant_id, agent_id) que têm ao menos uma execução STALE
 * `in_progress` (`last_activity_at < cutoff`), ordenadas pela execução stale
 * MAIS ANTIGA de cada tupla, ascendente. Roda OUTSIDE de qualquer tenant
 * context — é o dispatcher. `system`/`default` não têm execuções seeded.
 *
 * A ordenação `MIN(last_activity_at) ASC` é a propriedade load-bearing: o
 * orçamento global (`REAPER_GLOBAL_BUDGET`) faz o loop parar no meio da lista,
 * então sem essa ordem as tuplas do topo consumiriam o orçamento todo tick e
 * as de baixo passariam fome. Com oldest-first, uma tupla não atendida só
 * envelhece e sobe ao topo no próximo tick → progresso eventual garantido.
 *
 * Aplica o cutoff de TTL na própria enumeração (antes era um `selectDistinct`
 * sem TTL + filtro posterior em `listStaleInProgress`), então tuplas só com
 * execuções frescas não aparecem. Usa o índice
 * `procedure_exec_tenant_agent_status_idx (tenant_id, agent_id, status,
 * last_activity_at)`. `MIN(last_activity_at)` é expresso via `sql` para servir
 * como chave de ordenação (drizzle tipa o agregado de forma frouxa); só as
 * colunas de escopo são projetadas — o `oldest` existe apenas para ordenar.
 */
async function listStaleTenantAgentTuples(cutoff: Date): Promise<TenantAgentRow[]> {
  const rows = await db
    .select({
      tenant_id: procedure_executions.tenant_id,
      agent_id: procedure_executions.agent_id,
      oldest: sql<string>`min(${procedure_executions.last_activity_at})`.as('oldest'),
    })
    .from(procedure_executions)
    .where(
      and(
        eq(procedure_executions.status, 'in_progress'),
        lt(procedure_executions.last_activity_at, cutoff),
      ),
    )
    .groupBy(procedure_executions.tenant_id, procedure_executions.agent_id)
    .orderBy(sql`oldest asc`);
  return rows.map((r) => ({ tenant_id: r.tenant_id, agent_id: r.agent_id }));
}

export async function runProcedureExecutionReaper(): Promise<void> {
  // Same staleness cutoff the per-tuple `listStaleInProgress` read applies, so
  // the dispatcher only enumerates tuples that actually have work this tick and
  // orders them by their oldest stale execution (fairness — see docstring).
  const cutoff = new Date(Date.now() - TTL_DAYS * 86_400_000);
  const tuples = await listStaleTenantAgentTuples(cutoff);
  let reaped = 0;
  let batch_capped = false;
  let budget_exhausted = false;
  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    // Issue #323 (Phase 3): stop visiting further tuples once the global
    // per-tick budget is spent. The remaining tuples drain on the next tick
    // (the reaper is idempotent and re-enumerates from scratch each run).
    if (reaped >= GLOBAL_BUDGET) {
      budget_exhausted = true;
      break;
    }
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
          // Issue #323 (Phase 3): honor the global per-tick budget INSIDE the
          // per-tuple loop too, so a single high-backlog tuple can't blow far
          // past the global cap. The unreaped tail of this tuple is picked up
          // on the next tick.
          if (reaped >= GLOBAL_BUDGET) {
            budget_exhausted = true;
            break;
          }
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
      global_budget: GLOBAL_BUDGET,
      budget_exhausted,
    },
    'procedure_execution_reaper.done',
  );
}
