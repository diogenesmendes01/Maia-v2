import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { healthRepo } from '@/db/repositories.js';

/**
 * P3c Task 10 — `procedure-metrics-refresh`.
 *
 * Worker periódico (cron `*\/15 * * * *`) que refresca a materialized view
 * `procedure_metrics` (criada em Task 2 com índice UNIQUE em `definition_id`
 * — pré-requisito do `REFRESH MATERIALIZED VIEW CONCURRENTLY`).
 *
 * Diferentemente da maioria dos workers do P3, este NÃO roda dentro de
 * `runWithTenantContext`: a matview agrega métricas cross-tenant e o
 * comando de refresh em si não passa por nenhum path tenant-aware
 * (RLS/escopo de leitura). Forçar tenant context aqui só introduziria
 * confusão semântica.
 *
 * `CONCURRENTLY` mantém leituras concorrentes da view enquanto o refresh
 * acontece — leitores não bloqueiam, e a janela de inconsistência é apenas
 * a duração do próprio refresh. O custo é precisar do índice unique, que
 * a Task 2 já garante.
 *
 * PR #85 fix P85-I4 — observabilidade: emite uma row em
 * `system_health_events` (component=`procedure_metrics_refresh`,
 * status=`ok|down`, duration_ms) por execução. Esse é o sinal que o
 * DLQ-monitor / dashboards usam para pagear ops quando a matview vai
 * stale (ex.: deadlock contra um `AccessExclusiveLock` durante deploy).
 * Health write é best-effort — uma falha no INSERT não pode mascarar nem
 * propagar a falha do refresh em si.
 */
const HEALTH_COMPONENT = 'procedure_metrics_refresh';

export async function runProcedureMetricsRefresh(): Promise<void> {
  const start = Date.now();
  try {
    await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics`);
    const elapsed_ms = Date.now() - start;
    logger.info({ elapsed_ms }, 'procedure_metrics_refresh.done');
    try {
      await healthRepo.record({
        component: HEALTH_COMPONENT,
        status: 'ok',
        duration_ms: elapsed_ms,
      });
    } catch (healthErr) {
      // Health emission is best-effort — refusing to mask the success path.
      logger.warn({ err: healthErr }, 'procedure_metrics_refresh.health_write_failed');
    }
  } catch (err) {
    const elapsed_ms = Date.now() - start;
    logger.error({ err, elapsed_ms }, 'procedure_metrics_refresh.failed');
    try {
      await healthRepo.record({
        component: HEALTH_COMPONENT,
        status: 'down',
        duration_ms: elapsed_ms,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (healthErr) {
      // Don't shadow the original failure if the health row itself fails.
      logger.warn({ err: healthErr }, 'procedure_metrics_refresh.health_write_failed');
    }
    throw err;
  }
}
