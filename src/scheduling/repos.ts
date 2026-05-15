/**
 * Spec 18 — Scheduling repos (series / occurrences / tasks / outbox).
 *
 * The hot paths use raw SQL because the operational semantics require
 * Postgres features Drizzle abstracts away:
 *   - `FOR UPDATE SKIP LOCKED` for the engine and outbox claim queries
 *   - atomic UPDATE ... WHERE version=? for series-cancel races
 *   - ON CONFLICT DO NOTHING for occurrence idempotency
 *
 * Callers should treat these as the single point of database access for
 * the scheduling domain so concurrency assumptions stay encoded in one
 * place.
 */

import { sql, eq, and, inArray, desc } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import {
  series as seriesTable,
  occurrences as occurrencesTable,
  tasks as tasksTable,
  outbox_messages as outboxTable,
  type Series,
  type SeriesInsert,
  type Occurrence,
  type Task,
  type OutboxMessage,
  type OutboxMessageInsert,
} from '@/db/schema.js';
import type {
  OccurrenceStatus,
  OutboxStatus,
  SeriesContexto,
  TaskKind,
  TaskStatus,
} from './types.js';

type Tx = typeof db;

export type CreateSeriesInput = Omit<SeriesInsert, 'id' | 'created_at' | 'updated_at' | 'version'> & {
  initial_occurrence: {
    scheduled_for: Date;
    contexto_snapshot: SeriesContexto;
    correlation_token?: string;
    tasks: Array<{ ordem: number; kind: TaskKind }>;
  };
};

export const seriesRepo = {
  async findById(id: string): Promise<Series | null> {
    const rows = await db.select().from(seriesTable).where(eq(seriesTable.id, id)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Atomically create a series + its first occurrence + that occurrence's
   * task rows. The two writes are wrapped in a single transaction so the
   * scheduling domain never has an orphan series (series with no upcoming
   * occurrence) immediately after creation.
   */
  async createWithFirstOccurrence(input: CreateSeriesInput): Promise<{
    series: Series;
    occurrence: Occurrence;
    tasks: Task[];
  }> {
    return withTx(async (tx) => {
      const seriesRows = await tx
        .insert(seriesTable)
        .values({
          tipo: input.tipo,
          status: input.status ?? 'active',
          rrule: input.rrule ?? null,
          one_shot_at: input.one_shot_at ?? null,
          month_end_policy: input.month_end_policy ?? 'skip_invalid_month',
          missed_run_policy: input.missed_run_policy ?? 'fire_latest_only',
          staleness_threshold_hours: input.staleness_threshold_hours ?? 24,
          exclusive_per_destinatario: input.exclusive_per_destinatario ?? false,
          contexto_template: input.contexto_template,
          entidade_id: input.entidade_id ?? null,
          owner_pessoa_id: input.owner_pessoa_id,
        })
        .returning();
      const s = seriesRows[0]!;

      const occRows = await tx
        .insert(occurrencesTable)
        .values({
          series_id: s.id,
          scheduled_for: input.initial_occurrence.scheduled_for,
          status: 'pending',
          contexto_snapshot: input.initial_occurrence.contexto_snapshot,
          correlation_token: input.initial_occurrence.correlation_token ?? null,
        })
        .returning();
      const occ = occRows[0]!;

      const taskRows = await tx
        .insert(tasksTable)
        .values(
          input.initial_occurrence.tasks.map((t) => ({
            occurrence_id: occ.id,
            ordem: t.ordem,
            kind: t.kind,
            status: 'pending' as TaskStatus,
          })),
        )
        .returning();

      return { series: s, occurrence: occ, tasks: taskRows };
    });
  },

  /**
   * Atomic series cancellation. Bumps version AND cancels all pending/
   * claimed occurrences in one transaction so a concurrent engine tick
   * cannot create or claim further occurrences once this commits.
   */
  async cancelAtomic(
    series_id: string,
    actor_pessoa_id: string,
  ): Promise<{ series: Series | null; cancelled_occurrence_ids: string[] }> {
    return withTx(async (tx) => {
      const updated = await tx
        .update(seriesTable)
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          version: sql`${seriesTable.version} + 1`,
          updated_at: new Date(),
        })
        .where(and(eq(seriesTable.id, series_id), eq(seriesTable.status, 'active')))
        .returning();
      if (updated.length === 0) {
        const existing = await tx
          .select()
          .from(seriesTable)
          .where(eq(seriesTable.id, series_id))
          .limit(1);
        return { series: existing[0] ?? null, cancelled_occurrence_ids: [] };
      }
      const s = updated[0]!;
      const occUpdated = await tx
        .update(occurrencesTable)
        .set({ status: 'cancelled', completed_at: new Date() })
        .where(
          and(
            eq(occurrencesTable.series_id, series_id),
            inArray(occurrencesTable.status, ['pending', 'claimed']),
          ),
        )
        .returning({ id: occurrencesTable.id });
      void actor_pessoa_id;
      return { series: s, cancelled_occurrence_ids: occUpdated.map((r) => r.id) };
    });
  },

  /**
   * Backfill scheduler support: active series whose next future occurrence
   * is missing or already in a terminal state (Blocker 7 — series_next_
   * scheduler in spec §10).
   */
  async listActiveWithoutPendingOccurrence(limit: number): Promise<Series[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT s.*
        FROM series s
       WHERE s.status = 'active'
         AND s.rrule IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM occurrences o
            WHERE o.series_id = s.id
              AND o.status IN ('pending','claimed','in_progress','awaiting_third_party','awaiting_owner')
         )
       ORDER BY s.updated_at ASC
       LIMIT ${limit}
    `);
    return rows.rows as unknown as Series[];
  },

  /**
   * Used by the engine when advancing a series-driven task that needs to
   * insert the NEXT occurrence: passes the version observed when the
   * current occurrence was started. If the series has been cancelled or
   * mutated in between, the insert affects 0 rows and the engine drops
   * the next-occurrence attempt.
   */
  async insertNextOccurrenceIfActive(input: {
    series_id: string;
    expected_version: number;
    scheduled_for: Date;
    contexto_snapshot: SeriesContexto;
    correlation_token?: string;
    tasks: Array<{ ordem: number; kind: TaskKind }>;
  }): Promise<{ occurrence: Occurrence | null; tasks: Task[] }> {
    return withTx(async (tx) => {
      // Strongest defence: gate the insert on (status=active, version match)
      // via a sub-select-rejected-if-empty trick.
      const guard = await tx
        .select()
        .from(seriesTable)
        .where(
          and(
            eq(seriesTable.id, input.series_id),
            eq(seriesTable.status, 'active'),
            eq(seriesTable.version, input.expected_version),
          ),
        )
        .limit(1);
      if (guard.length === 0) return { occurrence: null, tasks: [] };

      try {
        const occRows = await tx
          .insert(occurrencesTable)
          .values({
            series_id: input.series_id,
            scheduled_for: input.scheduled_for,
            status: 'pending',
            contexto_snapshot: input.contexto_snapshot,
            correlation_token: input.correlation_token ?? null,
          })
          .returning();
        const occ = occRows[0]!;
        const taskRows = await tx
          .insert(tasksTable)
          .values(
            input.tasks.map((t) => ({
              occurrence_id: occ.id,
              ordem: t.ordem,
              kind: t.kind,
              status: 'pending' as TaskStatus,
            })),
          )
          .returning();
        return { occurrence: occ, tasks: taskRows };
      } catch (err) {
        // UNIQUE (series_id, scheduled_for) collision — another worker beat
        // us to it. Idempotent: return null and let the loser drop the work.
        if (/duplicate key|unique constraint/i.test((err as Error).message)) {
          return { occurrence: null, tasks: [] };
        }
        throw err;
      }
    });
  },
};

/**
 * Wraps a series of scheduling writes in a single transaction. Used by the
 * engine to make outbox enqueue + task status + occurrence status atomic
 * (spec 18 §7.1). Either all three writes commit, or none — no half-state.
 */
export async function advanceWithTx<T>(fn: (tx: Tx, t: TxScopedRepos) => Promise<T>): Promise<T> {
  return withTx((tx) => fn(tx, txRepos(tx)));
}

export type TxScopedRepos = {
  occurrences: {
    setStatus: (
      id: string,
      status: OccurrenceStatus,
      extra?: { outcome?: string; metadata_patch?: Record<string, unknown> },
    ) => Promise<void>;
  };
  tasks: {
    setStatus: (
      id: string,
      status: TaskStatus,
      result_patch?: Record<string, unknown>,
    ) => Promise<void>;
  };
  outbox: {
    enqueue: (
      input: Omit<
        OutboxMessageInsert,
        'id' | 'created_at' | 'status' | 'attempts' | 'next_attempt_at'
      >,
    ) => Promise<OutboxMessage | null>;
  };
};

function txRepos(tx: Tx): TxScopedRepos {
  return {
    occurrences: {
      async setStatus(id, status, extra): Promise<void> {
        const update: Record<string, unknown> = { status };
        if (
          status === 'in_progress' ||
          status === 'awaiting_third_party' ||
          status === 'awaiting_owner'
        ) {
          update.started_at = new Date();
        }
        if (
          status === 'completed' ||
          status === 'skipped' ||
          status === 'failed' ||
          status === 'aged_out' ||
          status === 'cancelled'
        ) {
          update.completed_at = new Date();
        }
        if (extra?.outcome !== undefined) update.outcome = extra.outcome;
        if (extra?.metadata_patch) {
          update.metadata = sql`COALESCE(metadata,'{}'::jsonb) || ${JSON.stringify(extra.metadata_patch)}::jsonb`;
        }
        await tx.update(occurrencesTable).set(update).where(eq(occurrencesTable.id, id));
      },
    },
    tasks: {
      async setStatus(id, status, result_patch): Promise<void> {
        const update: Record<string, unknown> = { status };
        if (status === 'in_progress') update.started_at = new Date();
        if (status === 'completed' || status === 'skipped' || status === 'failed') {
          update.completed_at = new Date();
        }
        if (result_patch) {
          update.result = sql`COALESCE(result,'{}'::jsonb) || ${JSON.stringify(result_patch)}::jsonb`;
        }
        await tx.update(tasksTable).set(update).where(eq(tasksTable.id, id));
      },
    },
    outbox: {
      async enqueue(input): Promise<OutboxMessage | null> {
        try {
          const rows = await tx
            .insert(outboxTable)
            .values({
              occurrence_id: input.occurrence_id ?? null,
              task_id: input.task_id ?? null,
              kind: input.kind,
              payload: input.payload,
              dedup_key: input.dedup_key ?? null,
              max_attempts: input.max_attempts ?? 5,
            })
            .returning();
          return rows[0] ?? null;
        } catch (err) {
          if (/duplicate key|unique constraint/i.test((err as Error).message)) return null;
          throw err;
        }
      },
    },
  };
}

export const occurrencesRepo = {
  async byId(id: string): Promise<Occurrence | null> {
    const rows = await db.select().from(occurrencesTable).where(eq(occurrencesTable.id, id)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Claim up to `limit` due occurrences in one transaction using
   * `FOR UPDATE SKIP LOCKED`. Returns the claimed rows already stamped
   * with the worker_id and claimed_at.
   */
  async claimDue(worker_id: string, limit: number): Promise<Occurrence[]> {
    const rows = await db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM occurrences
         WHERE status = 'pending' AND scheduled_for <= now()
         ORDER BY scheduled_for ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE occurrences o
         SET status = 'claimed', claimed_by = ${worker_id}, claimed_at = now()
        FROM due
       WHERE o.id = due.id
       RETURNING o.id;
    `);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(occurrencesTable).where(inArray(occurrencesTable.id, ids));
  },

  /**
   * Reclaim leases that expired without completing — another worker crashed
   * mid-advance. Resets the row to `pending` so the next `claimDue` pass
   * picks it up normally (and also stamps it claimed_by=<new worker> so
   * subsequent reaper passes within the same tick don't double-handle).
   *
   * Returns the IDs so the caller can audit the recovery, but the caller
   * should NOT process them directly — they're back in the pending queue.
   */
  async reclaimExpiredLeases(_worker_id: string, ttl_seconds: number, limit: number): Promise<string[]> {
    const rows = await db.execute<{ id: string }>(sql`
      WITH expired AS (
        SELECT id FROM occurrences
         WHERE status = 'claimed'
           AND claimed_at < now() - (${ttl_seconds} || ' seconds')::interval
         ORDER BY claimed_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE occurrences o
         SET status = 'pending',
             claimed_by = NULL,
             claimed_at = NULL
        FROM expired
       WHERE o.id = expired.id
       RETURNING o.id;
    `);
    return rows.rows.map((r) => r.id);
  },

  async setStatus(
    id: string,
    status: OccurrenceStatus,
    extra?: { outcome?: string; metadata_patch?: Record<string, unknown> },
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    // Anchor `started_at` whenever we transition into any "started"
    // state. `awaiting_third_party` and `awaiting_owner` mean the work
    // has begun and we're now waiting for an external party — for the
    // timeout query to fire, those rows MUST have `started_at` set.
    // Previously only `in_progress` set this and timeouts never matched.
    if (
      status === 'in_progress' ||
      status === 'awaiting_third_party' ||
      status === 'awaiting_owner'
    ) {
      update.started_at = new Date();
    }
    if (
      status === 'completed' ||
      status === 'skipped' ||
      status === 'failed' ||
      status === 'aged_out' ||
      status === 'cancelled'
    ) {
      update.completed_at = new Date();
    }
    if (extra?.outcome !== undefined) update.outcome = extra.outcome;
    if (extra?.metadata_patch) {
      update.metadata = sql`COALESCE(metadata,'{}'::jsonb) || ${JSON.stringify(extra.metadata_patch)}::jsonb`;
    }
    await db.update(occurrencesTable).set(update).where(eq(occurrencesTable.id, id));
  },

  /**
   * Release a claim WITHOUT advancing — returns the row to `pending` so the
   * next tick retries. Used when the engine defers an advance due to a
   * runtime gate (exclusive_per_destinatario collision, missing conversa).
   */
  async releaseClaim(id: string, defer_seconds = 60): Promise<void> {
    await db
      .update(occurrencesTable)
      .set({
        status: 'pending',
        claimed_by: null,
        claimed_at: null,
        scheduled_for: sql`GREATEST(scheduled_for, now() + (${defer_seconds} || ' seconds')::interval)`,
      })
      .where(eq(occurrencesTable.id, id));
  },

  /**
   * For `recurring_outreach`, after a response is captured the engine needs
   * to advance the occurrence through its remaining steps (forward + next
   * cycle). The original `claimDue` only picks up `pending`, so we have a
   * second claim path for `in_progress` occurrences that need engine love.
   *
   * Review 3 BLOCKER fix: the query MUST be restricted to series of type
   * `recurring_outreach`. Otherwise a `one_shot_reminder` whose engine
   * transition flipped the occurrence to `in_progress` (then enqueued the
   * outbox) is picked up here while the outbox is still pending — the
   * engine then runs `advanceInProgressOccurrence`, sees no recurring
   * advance to do, and historically marked the occurrence completed,
   * producing a phantom success while the underlying message never sent.
   *
   * Completion for `one_shot_reminder` (and any other non-outreach tipo)
   * MUST flow through outbox-drain after a confirmed `markSent`, or
   * through `onMessageDead` after exhausting retries.
   */
  async claimInProgressForAdvance(worker_id: string, limit: number): Promise<Occurrence[]> {
    const rows = await db.execute<{ id: string }>(sql`
      WITH eligible AS (
        SELECT o.id
          FROM occurrences o
          JOIN series s ON s.id = o.series_id
         WHERE o.status = 'in_progress'
           AND s.tipo = 'recurring_outreach'
           AND (o.claimed_at IS NULL OR o.claimed_at < now() - interval '30 seconds')
         ORDER BY o.created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE occurrences o
         SET claimed_by = ${worker_id}, claimed_at = now()
        FROM eligible
       WHERE o.id = eligible.id
       RETURNING o.id;
    `);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(occurrencesTable).where(inArray(occurrencesTable.id, ids));
  },

  /**
   * For `recurring_outreach`, scan `awaiting_third_party` rows whose
   * wait window expired so the engine can escalate to the owner.
   */
  async listAwaitingTimedOut(limit: number): Promise<Occurrence[]> {
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.status, 'awaiting_third_party'),
          sql`(contexto_snapshot->>'wait_response_hours') IS NOT NULL`,
          sql`started_at IS NOT NULL`,
          sql`started_at + ((contexto_snapshot->>'wait_response_hours')::int || ' hours')::interval < now()`,
        ),
      )
      .limit(limit);
  },

  async listOverdueForSeries(series_id: string, threshold_at: Date): Promise<Occurrence[]> {
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.series_id, series_id),
          eq(occurrencesTable.status, 'pending'),
          sql`scheduled_for < ${threshold_at}`,
        ),
      )
      .orderBy(occurrencesTable.scheduled_for);
  },

  async findActiveByCorrelation(token: string): Promise<Occurrence | null> {
    const rows = await db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.correlation_token, token),
          inArray(occurrencesTable.status, ['awaiting_third_party', 'in_progress']),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listAwaitingForDestinatario(destinatario_pessoa_id: string): Promise<Occurrence[]> {
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.status, 'awaiting_third_party'),
          sql`(contexto_snapshot->>'destinatario_pessoa_id') = ${destinatario_pessoa_id}`,
        ),
      )
      .orderBy(desc(occurrencesTable.scheduled_for));
  },

  async hasOpenForDestinatario(series_id: string, destinatario_pessoa_id: string): Promise<boolean> {
    const rows = await db
      .select({ id: occurrencesTable.id })
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.series_id, series_id),
          inArray(occurrencesTable.status, [
            'pending',
            'claimed',
            'in_progress',
            'awaiting_third_party',
          ]),
          sql`(contexto_snapshot->>'destinatario_pessoa_id') = ${destinatario_pessoa_id}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /** Like hasOpenForDestinatario but excludes a single occurrence id —
   * used during advance to check siblings without seeing ourselves. */
  async hasOpenForDestinatarioExcluding(
    series_id: string,
    destinatario_pessoa_id: string,
    exclude_occurrence_id: string,
  ): Promise<boolean> {
    const rows = await db
      .select({ id: occurrencesTable.id })
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.series_id, series_id),
          sql`id <> ${exclude_occurrence_id}`,
          inArray(occurrencesTable.status, ['in_progress', 'awaiting_third_party']),
          sql`(contexto_snapshot->>'destinatario_pessoa_id') = ${destinatario_pessoa_id}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async listByStatus(statuses: OccurrenceStatus[], limit = 100): Promise<Occurrence[]> {
    return db
      .select()
      .from(occurrencesTable)
      .where(inArray(occurrencesTable.status, statuses))
      .limit(limit);
  },
};

export const tasksRepo = {
  async byOccurrence(occurrence_id: string): Promise<Task[]> {
    return db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.occurrence_id, occurrence_id))
      .orderBy(tasksTable.ordem);
  },

  async setStatus(
    id: string,
    status: TaskStatus,
    result_patch?: Record<string, unknown>,
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === 'in_progress') update.started_at = new Date();
    if (
      status === 'completed' ||
      status === 'skipped' ||
      status === 'failed'
    ) {
      update.completed_at = new Date();
    }
    if (result_patch) {
      update.result = sql`COALESCE(result,'{}'::jsonb) || ${JSON.stringify(result_patch)}::jsonb`;
    }
    await db.update(tasksTable).set(update).where(eq(tasksTable.id, id));
  },
};

export const outboxRepo = {
  async enqueue(input: Omit<OutboxMessageInsert, 'id' | 'created_at' | 'status' | 'attempts' | 'next_attempt_at'>): Promise<OutboxMessage | null> {
    try {
      const rows = await db
        .insert(outboxTable)
        .values({
          occurrence_id: input.occurrence_id ?? null,
          task_id: input.task_id ?? null,
          kind: input.kind,
          payload: input.payload,
          dedup_key: input.dedup_key ?? null,
          max_attempts: input.max_attempts ?? 5,
        })
        .returning();
      return rows[0] ?? null;
    } catch (err) {
      // Dedup collision is idempotent success — caller already enqueued.
      if (/duplicate key|unique constraint/i.test((err as Error).message)) return null;
      throw err;
    }
  },

  async claimDue(worker_id: string, limit: number): Promise<OutboxMessage[]> {
    const rows = await db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM outbox_messages
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE outbox_messages o
         SET status = 'claimed', claimed_by = ${worker_id}, claimed_at = now()
        FROM due
       WHERE o.id = due.id
       RETURNING o.id;
    `);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(outboxTable).where(inArray(outboxTable.id, ids));
  },

  async reclaimExpiredLeases(_worker_id: string, ttl_seconds: number, limit: number): Promise<string[]> {
    const rows = await db.execute<{ id: string }>(sql`
      WITH expired AS (
        SELECT id FROM outbox_messages
         WHERE status = 'claimed'
           AND claimed_at < now() - (${ttl_seconds} || ' seconds')::interval
         ORDER BY claimed_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE outbox_messages o
         SET status = 'pending',
             claimed_by = NULL,
             claimed_at = NULL
        FROM expired
       WHERE o.id = expired.id
       RETURNING o.id;
    `);
    return rows.rows.map((r) => r.id);
  },

  async markSent(id: string): Promise<void> {
    await db
      .update(outboxTable)
      .set({ status: 'sent', sent_at: new Date(), last_error: null })
      .where(eq(outboxTable.id, id));
  },

  async markFailedRetryable(id: string, error: string, backoff_seconds: number): Promise<void> {
    await db
      .update(outboxTable)
      .set({
        status: 'pending',
        last_error: error,
        attempts: sql`${outboxTable.attempts} + 1`,
        next_attempt_at: sql`now() + (${backoff_seconds} || ' seconds')::interval`,
        claimed_by: null,
        claimed_at: null,
      })
      .where(eq(outboxTable.id, id));
  },

  async markDead(id: string, error: string): Promise<void> {
    await db
      .update(outboxTable)
      .set({
        status: 'dead',
        last_error: error,
        attempts: sql`${outboxTable.attempts} + 1`,
      })
      .where(eq(outboxTable.id, id));
  },

  async returnToPending(id: string): Promise<void> {
    await db
      .update(outboxTable)
      .set({ status: 'pending', claimed_by: null, claimed_at: null })
      .where(eq(outboxTable.id, id));
  },

  async byStatus(status: OutboxStatus, limit = 100): Promise<OutboxMessage[]> {
    return db.select().from(outboxTable).where(eq(outboxTable.status, status)).limit(limit);
  },
};

export type SchedulingRepos = {
  series: typeof seriesRepo;
  occurrences: typeof occurrencesRepo;
  tasks: typeof tasksRepo;
  outbox: typeof outboxRepo;
};

export const schedulingRepos: SchedulingRepos = {
  series: seriesRepo,
  occurrences: occurrencesRepo,
  tasks: tasksRepo,
  outbox: outboxRepo,
};
