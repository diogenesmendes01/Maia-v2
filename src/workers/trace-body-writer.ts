/**
 * P10b — `trace-body-writer` worker (every minute).
 *
 * Drains BOTH:
 *   1. The durable `runtime_trace_body_outbox` table via FOR UPDATE SKIP
 *      LOCKED (cross-replica safe; survives process crashes — Codex
 *      review #102 issue 4).
 *   2. The in-process Map (fast path for hot reuse within a single
 *      process tick — best-effort accelerator only; the durable outbox is
 *      the source of truth).
 *
 * Idempotency: writeBody → INSERT ... ON CONFLICT (trace_id) DO NOTHING,
 * and after a successful body write the outbox row is deleted. Multiple
 * workers competing for the same row are safe because SKIP LOCKED keeps
 * them disjoint.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { writeBody } from '@/control-plane/runtime-trace/body-writer.js';
import type { TraceBodyInput } from '@/control-plane/runtime-trace/types.js';
import { incCounter } from '@/lib/metrics.js';

// In-process accelerator. Source of truth is the DB outbox table.
const QUEUE = new Map<string, TraceBodyInput>();

/** Enqueue a body for async write (in-process; collapses per trace_id). */
export function enqueueBody(input: TraceBodyInput): void {
  QUEUE.set(input.trace_id, input);
}

/** Test helper. */
export function _peekQueueSize(): number {
  return QUEUE.size;
}

/** Test helper: clear the in-process queue between tests. */
export function _resetQueueForTests(): void {
  QUEUE.clear();
}

/** How many outbox rows to claim per tick. Tunable; safe to over-pull. */
const OUTBOX_BATCH = 100;
/** Hard cap on retry attempts. Above this, rows are parked and alerted. */
const MAX_ATTEMPTS = 10;

interface OutboxRow {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  payload: Record<string, unknown>;
  redaction_class: 'standard' | 'debug' | 'minimal';
  attempts: number;
}

/**
 * Claim a batch of outbox rows with FOR UPDATE SKIP LOCKED.
 *
 * The CTE pattern (claim → return rows) keeps the transaction tight and
 * cross-replica safe — locked rows are simply skipped, so two workers
 * never operate on the same row. The actual body write happens OUTSIDE
 * this transaction (separate db.execute on writeBody), and on success
 * we delete the row in a follow-up transaction. The DB body row has
 * ON CONFLICT DO NOTHING, so a crash mid-flight is harmless.
 */
async function claimOutboxBatch(): Promise<OutboxRow[]> {
  const result = (await db.execute(
    sql`SELECT trace_id, tenant_id, agent_id, payload, redaction_class, attempts
        FROM runtime_trace_body_outbox
        WHERE attempts < ${MAX_ATTEMPTS}
        ORDER BY enqueued_at ASC
        LIMIT ${OUTBOX_BATCH}
        FOR UPDATE SKIP LOCKED`,
  )) as unknown as { rows: OutboxRow[] };
  return result.rows ?? [];
}

async function deleteOutboxRow(trace_id: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM runtime_trace_body_outbox WHERE trace_id = ${trace_id}`,
  );
}

async function bumpOutboxFailure(trace_id: string, err: Error): Promise<void> {
  await db.execute(
    sql`UPDATE runtime_trace_body_outbox
        SET attempts = attempts + 1,
            last_attempt_at = now(),
            last_error = ${err.message.slice(0, 500)}
        WHERE trace_id = ${trace_id}`,
  );
}

/** Worker entrypoint. Drains both sources, bounded by OUTBOX_BATCH. */
export async function runTraceBodyWriter(): Promise<void> {
  let outboxOk = 0;
  let outboxFailed = 0;
  let memoryOk = 0;
  let memoryFailed = 0;

  // === 1. Durable outbox path (source of truth). ===
  let outboxRows: OutboxRow[] = [];
  try {
    outboxRows = await claimOutboxBatch();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'trace_body_writer.outbox_claim_failed',
    );
  }

  for (const row of outboxRows) {
    try {
      const input: TraceBodyInput = {
        trace_id: row.trace_id,
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        packet: (row.payload as { packet: TraceBodyInput['packet'] }).packet,
        decision: (row.payload as { decision: TraceBodyInput['decision'] }).decision,
        redaction_class: row.redaction_class,
      };
      await writeBody(input);
      await deleteOutboxRow(row.trace_id);
      // Also remove any in-process duplicate so we don't double-write.
      QUEUE.delete(row.trace_id);
      outboxOk += 1;
    } catch (err) {
      outboxFailed += 1;
      logger.error(
        {
          err: (err as Error).message,
          trace_id: row.trace_id,
          attempts: row.attempts,
        },
        'trace_body_writer.outbox_write_failed',
      );
      try {
        await bumpOutboxFailure(row.trace_id, err as Error);
      } catch (bumpErr) {
        logger.warn(
          { err: (bumpErr as Error).message, trace_id: row.trace_id },
          'trace_body_writer.outbox_bump_failed',
        );
      }
    }
  }

  // === 2. In-process accelerator path. ===
  if (QUEUE.size > 0) {
    const drained = Array.from(QUEUE.values());
    QUEUE.clear();
    for (const input of drained) {
      try {
        await writeBody(input);
        memoryOk += 1;
      } catch (err) {
        memoryFailed += 1;
        logger.error(
          { err: (err as Error).message, trace_id: input.trace_id },
          'trace_body_writer.in_memory_failed',
        );
        // Re-enqueue for next tick. The durable outbox covers cross-process
        // gaps — this Map is just a perf accelerator.
        QUEUE.set(input.trace_id, input);
      }
    }
  }

  if (outboxOk > 0) {
    incCounter('maia_runtime_trace_body_writer_ok_total', { source: 'outbox' }, outboxOk);
  }
  if (memoryOk > 0) {
    incCounter('maia_runtime_trace_body_writer_ok_total', { source: 'in_memory' }, memoryOk);
  }
  if (outboxFailed > 0) {
    incCounter(
      'maia_runtime_trace_body_writer_failed_total',
      { source: 'outbox' },
      outboxFailed,
    );
  }
  if (memoryFailed > 0) {
    incCounter(
      'maia_runtime_trace_body_writer_failed_total',
      { source: 'in_memory' },
      memoryFailed,
    );
  }

  if (outboxOk + memoryOk + outboxFailed + memoryFailed === 0) return;
  logger.info(
    { outboxOk, outboxFailed, memoryOk, memoryFailed },
    'trace_body_writer.tick',
  );
}
