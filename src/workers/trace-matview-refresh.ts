/**
 * P10b — `trace-matview-refresh` worker (every 5 minutes).
 *
 * REFRESH MATERIALIZED VIEW CONCURRENTLY unified_trace_events.
 *
 * Same pattern as procedure-metrics-refresh: a UNIQUE index on (source,
 * trace_id) — created in migration 038 — is the contract that lets
 * CONCURRENTLY run without taking AccessExclusiveLock. Readers (Admin UI
 * trace browser) see a stale-but-consistent view while the refresh runs.
 *
 * Health emission mirrors procedure-metrics-refresh — pages ops if the
 * refresh starts failing (most likely cause: a source table got renamed
 * without updating the matview definition; revisit migration 038).
 */
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { healthRepo } from '@/db/repositories.js';

const HEALTH_COMPONENT = 'trace_matview_refresh';

export async function runTraceMatviewRefresh(): Promise<void> {
  const start = Date.now();
  try {
    await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY unified_trace_events`);
    const elapsed_ms = Date.now() - start;
    logger.info({ elapsed_ms }, 'trace_matview_refresh.done');
    try {
      await healthRepo.record({
        component: HEALTH_COMPONENT,
        status: 'ok',
        duration_ms: elapsed_ms,
      });
    } catch (healthErr) {
      logger.warn({ err: healthErr }, 'trace_matview_refresh.health_write_failed');
    }
  } catch (err) {
    const elapsed_ms = Date.now() - start;
    logger.error({ err, elapsed_ms }, 'trace_matview_refresh.failed');
    try {
      await healthRepo.record({
        component: HEALTH_COMPONENT,
        status: 'down',
        duration_ms: elapsed_ms,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (healthErr) {
      logger.warn({ err: healthErr }, 'trace_matview_refresh.health_write_failed');
    }
    throw err;
  }
}
