/**
 * P10b — `trace-body-recoverer` worker (every 5 minutes).
 *
 * Walks runtime_trace_envelopes WHERE body_status='pending' AND created_at
 * < now() - RUNTIME_TRACE_BODY_ORPHAN_SEC. Two outcomes:
 *
 *   1. There's a corresponding row in runtime_trace_bodies that already
 *      landed (the body worker wrote it but failed the envelope flip).
 *      → just flip the envelope.
 *   2. No body row exists after the orphan threshold.
 *      → mark envelope.body_status='orphaned' and alert.
 *
 * "orphaned" is a permanent-ish state — it means we have proof the
 * decision was made (envelope is intact) but the contextual evidence is
 * gone. This is the "audit row preserved, body lost" failure mode that
 * the dual-pattern is designed to make survivable.
 *
 * Locking: `FOR UPDATE SKIP LOCKED` so multiple recoverer replicas don't
 * fight over the same envelopes.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';
import { incCounter } from '@/lib/metrics.js';

const BATCH_SIZE = 200;

export async function runTraceBodyRecoverer(): Promise<void> {
  const orphan_sec = config.RUNTIME_TRACE_BODY_ORPHAN_SEC;
  const cutoff = new Date(Date.now() - orphan_sec * 1000).toISOString();

  // Single query that:
  //   (a) finds pending envelopes older than the threshold,
  //   (b) LEFT JOINs the bodies table to detect "body already landed",
  //   (c) updates either to 'persisted' (if body exists) or 'orphaned'.
  // We use a CTE for clarity.
  const result = await db.execute(
    sql`WITH candidates AS (
      SELECT e.trace_id, e.tenant_id, e.agent_id,
             (b.trace_id IS NOT NULL) AS has_body
      FROM runtime_trace_envelopes e
      LEFT JOIN runtime_trace_bodies b ON b.trace_id = e.trace_id
      WHERE e.body_status = 'pending'
        AND e.created_at < ${cutoff}
      ORDER BY e.created_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE OF e SKIP LOCKED
    ),
    persisted_upd AS (
      UPDATE runtime_trace_envelopes
      SET body_status = 'persisted', body_persisted_at = now()
      WHERE trace_id IN (SELECT trace_id FROM candidates WHERE has_body = true)
      RETURNING trace_id
    ),
    orphaned_upd AS (
      UPDATE runtime_trace_envelopes
      SET body_status = 'orphaned'
      WHERE trace_id IN (SELECT trace_id FROM candidates WHERE has_body = false)
      RETURNING trace_id
    )
    SELECT
      (SELECT count(*) FROM persisted_upd) AS persisted_count,
      (SELECT count(*) FROM orphaned_upd) AS orphaned_count`,
  );

  // pg returns rows[0]; drizzle exposes .rows on raw execute.
  const row = (result as unknown as { rows: Array<{ persisted_count: string; orphaned_count: string }> }).rows[0];
  const persisted = row ? Number(row.persisted_count) : 0;
  const orphaned = row ? Number(row.orphaned_count) : 0;

  if (persisted > 0) {
    incCounter('maia_runtime_trace_body_recoverer_persisted_total', {}, persisted);
  }
  if (orphaned > 0) {
    incCounter('maia_runtime_trace_body_recoverer_orphaned_total', {}, orphaned);
    logger.warn(
      { orphaned, orphan_sec, cutoff },
      'trace_body_recoverer.alert_orphaned_envelopes',
    );
  }
  logger.info({ persisted, orphaned }, 'trace_body_recoverer.tick');
}
