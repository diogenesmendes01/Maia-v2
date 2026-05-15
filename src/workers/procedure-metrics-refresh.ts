import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

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
 */
export async function runProcedureMetricsRefresh(): Promise<void> {
  const start = Date.now();
  try {
    await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics`);
    logger.info({ elapsed_ms: Date.now() - start }, 'procedure_metrics_refresh.done');
  } catch (err) {
    logger.error({ err, elapsed_ms: Date.now() - start }, 'procedure_metrics_refresh.failed');
    throw err;
  }
}
