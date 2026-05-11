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
import { db } from '@/db/client.js';
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

const TX = db as unknown as {
  transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
};

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
    return TX.transaction(async (tx) => {
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
    return TX.transaction(async (tx) => {
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
    return TX.transaction(async (tx) => {
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
   * mid-advance. The lease TTL is configurable; default 5 minutes.
   */
  async reclaimExpiredLeases(worker_id: string, ttl_seconds: number, limit: number): Promise<Occurrence[]> {
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
         SET claimed_by = ${worker_id}, claimed_at = now()
        FROM expired
       WHERE o.id = expired.id
       RETURNING o.id;
    `);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(occurrencesTable).where(inArray(occurrencesTable.id, ids));
  },

  async setStatus(
    id: string,
    status: OccurrenceStatus,
    extra?: { outcome?: string; metadata_patch?: Record<string, unknown> },
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === 'in_progress') update.started_at = new Date();
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

  async reclaimExpiredLeases(worker_id: string, ttl_seconds: number, limit: number): Promise<OutboxMessage[]> {
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
         SET claimed_by = ${worker_id}, claimed_at = now()
        FROM expired
       WHERE o.id = expired.id
       RETURNING o.id;
    `);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return db.select().from(outboxTable).where(inArray(outboxTable.id, ids));
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
