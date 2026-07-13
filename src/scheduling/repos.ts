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
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
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
import { channelsRepo } from '@/db/repositories/channel-repos.js';
import { TypedError } from '@/lib/utils.js';

type Tx = typeof db;

/**
 * Fase 0 (spec roteamento v4 §1.6) — rows novas whatsapp do outbox nascem COM
 * canal (o CHECK de 090 exige `channel_id` para kind whatsapp% em status
 * pending/claimed; kinds sem linha — email — ficam NULL). Enqueue sem canal
 * explícito resolve o canal ÚNICO ativo do agente corrente; zero/2+ é
 * fail-closed (o chamador proativo passa a ter que especificar) — NUNCA
 * escolhemos "o primário" entre vários.
 */
async function resolveOutboxChannelId(
  kind: string,
  explicit: string | null | undefined,
): Promise<string | null> {
  if (explicit) return explicit;
  if (!kind.startsWith('whatsapp')) return null;
  const sole = await channelsRepo.findSoleActiveForCurrentAgent();
  if (sole.kind !== 'one') {
    throw new TypedError(
      'channel_ambiguous',
      sole.kind === 'none'
        ? 'outbox enqueue: agent has no active channel'
        : 'outbox enqueue: agent has multiple active channels — caller must pass channel_id',
      { resolution: sole.kind, kind },
    );
  }
  return sole.id;
}

/**
 * Issue #355 — tenant scoping for the Spec-18 scheduling tables.
 *
 * Migrations 071/072/073 added `tenant_id`/`agent_id` (both `TEXT NOT NULL
 * DEFAULT 'default'`, FK to tenants/agents) to series / occurrences / tasks /
 * outbox_messages and re-led the hot partial indexes with (tenant_id, agent_id).
 * The columns existed but NO query read them. This module now scopes every
 * read/write to the ALS tenant context, mirroring the house pattern in
 * `src/db/repositories.ts` (`getCurrentTenant`/`getCurrentAgent` +
 * `applyTenantGuard`-style injection).
 *
 * Contract: EVERY repo method here resolves `(tenant_id, agent_id)` from the
 * active ALS context. Callers MUST run inside `runWithTenantContext`:
 *   - tool handlers (start-recurring-*, schedule-reminder, cancel-reminder) and
 *     the agent-core / pending-resolver paths already run inside a request
 *     context, so they inherit the caller's tenant/agent;
 *   - the scheduling workers (scheduling_tick / outbox_drain /
 *     series_next_scheduler) enumerate real `(tenant_id, agent_id)` tuples from
 *     the work tables and open `runWithTenantContext` per tuple (the
 *     reflection-batch / outbound-messages-sweeper idiom). See the
 *     `enumerate*Tenants` helpers below.
 *
 * Reads filter by tenant+agent; INSERTs stamp them from context; UPDATE/DELETE
 * include them in the WHERE. Where a 0-row mutation outcome would be a real bug
 * (status transitions, claims, sends) we FAIL LOUD, mirroring the H1–H5
 * mutation-hardening style already merged for the other repos.
 */

/**
 * Raw-SQL tenant/agent predicate fragment for the `FOR UPDATE SKIP LOCKED`
 * claim/reclaim CTEs (which can't use the Drizzle query builder). Inlined into
 * the CTE's WHERE so the claim only ever locks rows for the routed
 * `(tenant_id, agent_id)`.
 */
function tenantFilter(tenant_id: string, agent_id: string) {
  return sql`tenant_id = ${tenant_id} AND agent_id = ${agent_id}`;
}

/**
 * Fail-loud guard for tenant-scoped mutations whose 0-row outcome is a real
 * bug (the row exists — the caller just read it under the SAME context — so a
 * miss means the WHERE tenant/agent predicate failed to match, i.e. a
 * cross-tenant routing error or a lost ALS context). Mirrors the merged H1–H5
 * mutation-hardening assertions on the other repos
 * (cf. `procedureExecutionsRepo.updateStateTx` in `src/db/repositories.ts`):
 * the `.returning({ id }).length` idiom is the PORTABLE row count (node-postgres
 * `rowCount` is typed `number | null`). NOT used for genuinely conditional
 * mutations (cancel races, lease reclaim, ON CONFLICT, status-gated releases)
 * where 0 rows is an expected, benign outcome.
 */
function assertMutated(
  matched: number,
  op: string,
  ctx: { id: string; tenant_id: string; agent_id: string },
): void {
  if (matched === 0) {
    throw new Error(
      `scheduling.${op} matched 0 rows for id=${ctx.id} under tenant=${ctx.tenant_id} agent=${ctx.agent_id} — ` +
        `row missing or cross-tenant (tenant/agent predicate did not match the row the caller just read)`,
    );
  }
}

export type CreateSeriesInput = Omit<SeriesInsert, 'id' | 'created_at' | 'updated_at' | 'version' | 'tenant_id' | 'agent_id'> & {
  initial_occurrence: {
    scheduled_for: Date;
    contexto_snapshot: SeriesContexto;
    correlation_token?: string;
    tasks: Array<{ ordem: number; kind: TaskKind }>;
  };
};

export const seriesRepo = {
  async findById(id: string): Promise<Series | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(seriesTable)
      .where(
        and(
          eq(seriesTable.id, id),
          eq(seriesTable.tenant_id, tenant_id),
          eq(seriesTable.agent_id, agent_id),
        ),
      )
      .limit(1);
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
    // Stamp tenant/agent from the active ALS context on EVERY row in the
    // series → occurrence → tasks chain so the whole tree is owned by the
    // caller's tenant. (Throws MissingTenantContextError outside ALS, before
    // any write — same fail-closed contract as `applyTenantGuard`.)
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const seriesRows = await tx
        .insert(seriesTable)
        .values({
          tenant_id,
          agent_id,
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
          tenant_id,
          agent_id,
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
            tenant_id,
            agent_id,
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
    // Scope BOTH the cancel UPDATE and the not-found probe to the caller's
    // tenant/agent: a series owned by another tenant must be invisible here
    // (the UPDATE matches 0 rows AND the probe returns null → `not_found`),
    // never silently cancellable cross-tenant. The 0-row UPDATE outcome is a
    // legitimate race (already cancelled) so it is NOT fail-loud — we
    // distinguish not-found from already-cancelled via the scoped probe.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const updated = await tx
        .update(seriesTable)
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          version: sql`${seriesTable.version} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(seriesTable.id, series_id),
            eq(seriesTable.tenant_id, tenant_id),
            eq(seriesTable.agent_id, agent_id),
            eq(seriesTable.status, 'active'),
          ),
        )
        .returning();
      if (updated.length === 0) {
        const existing = await tx
          .select()
          .from(seriesTable)
          .where(
            and(
              eq(seriesTable.id, series_id),
              eq(seriesTable.tenant_id, tenant_id),
              eq(seriesTable.agent_id, agent_id),
            ),
          )
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
            eq(occurrencesTable.tenant_id, tenant_id),
            eq(occurrencesTable.agent_id, agent_id),
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
    // Per-tenant: the backfill scheduler worker opens a context per enumerated
    // tuple, so this read is scoped to the current tenant/agent. The NOT EXISTS
    // sub-query also joins occurrences only within the same tenant/agent so a
    // sibling tenant's open occurrence can never mask a real orphan here.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT s.*
        FROM series s
       WHERE s.status = 'active'
         AND s.rrule IS NOT NULL
         AND s.tenant_id = ${tenant_id}
         AND s.agent_id = ${agent_id}
         AND NOT EXISTS (
           SELECT 1 FROM occurrences o
            WHERE o.series_id = s.id
              AND o.tenant_id = ${tenant_id}
              AND o.agent_id = ${agent_id}
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
    // Stamp tenant/agent on the new occurrence + tasks from the active context
    // (the engine/backfill caller runs inside the series' tenant), and scope
    // the active+version guard SELECT to that tenant so a sibling tenant's
    // series can never satisfy the guard. 0-row guard is a benign
    // cancellation/version race → return null (NOT fail-loud).
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      // Strongest defence: gate the insert on (status=active, version match)
      // via a sub-select-rejected-if-empty trick.
      const guard = await tx
        .select()
        .from(seriesTable)
        .where(
          and(
            eq(seriesTable.id, input.series_id),
            eq(seriesTable.tenant_id, tenant_id),
            eq(seriesTable.agent_id, agent_id),
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
            tenant_id,
            agent_id,
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
              tenant_id,
              agent_id,
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

export type TenantAgentRow = { tenant_id: string; agent_id: string };

/**
 * Issue #355 — dispatcher enumerations for the scheduling workers.
 *
 * Each method returns the DISTINCT `(tenant_id, agent_id)` tuples that have
 * work for one worker, so the worker can open `runWithTenantContext` per tuple
 * (the reflection-batch / outbound-messages-sweeper idiom). These run OUTSIDE
 * tenant context — enumerating across tenants is the worker's contract — so
 * they deliberately do NOT apply a tenant guard. No `'default'` sentinel is
 * assumed: a tuple appears here iff it genuinely has a due/claimable/orphaned
 * row, and the per-tenant inner re-scopes by the routed `(tenant_id, agent_id)`
 * (defense-in-depth against a dispatcher bug). The belt-and-suspenders
 * `tenant_id/agent_id IS NOT NULL` predicate mirrors #251/#292 (schema already
 * enforces NOT NULL; this guards a future relaxation).
 */
export const schedulingDispatch = {
  /**
   * Tuples with at least one occurrence the engine tick could act on this pass:
   * a due `pending` row, a `claimed` row that may need lease-reaping, an
   * `in_progress` recurring_outreach row eligible for advance, or an
   * `awaiting_third_party` row that may have timed out. Over-enumerating a tuple
   * whose rows turn out non-actionable is harmless — the per-tenant tick simply
   * claims/advances nothing.
   */
  async enumerateTickTenants(): Promise<TenantAgentRow[]> {
    const result = await db.execute<TenantAgentRow>(sql`
      SELECT DISTINCT o.tenant_id, o.agent_id
        FROM occurrences o
       WHERE o.tenant_id IS NOT NULL
         AND o.agent_id IS NOT NULL
         AND (
           (o.status = 'pending' AND o.scheduled_for <= now())
           OR o.status = 'claimed'
           OR o.status = 'in_progress'
           OR o.status = 'awaiting_third_party'
         )
    `);
    return Array.from(result.rows as unknown as TenantAgentRow[]);
  },

  /**
   * Tuples with at least one active rrule-driven series — the candidate set the
   * backfill scheduler may need to top up with a next occurrence. The inner
   * (`listActiveWithoutPendingOccurrence`) re-applies the full NOT-EXISTS orphan
   * filter scoped to the routed tenant/agent, so over-enumeration here is
   * harmless.
   */
  async enumerateActiveSeriesTenants(): Promise<TenantAgentRow[]> {
    const result = await db.execute<TenantAgentRow>(sql`
      SELECT DISTINCT s.tenant_id, s.agent_id
        FROM series s
       WHERE s.tenant_id IS NOT NULL
         AND s.agent_id IS NOT NULL
         AND s.status = 'active'
         AND s.rrule IS NOT NULL
    `);
    return Array.from(result.rows as unknown as TenantAgentRow[]);
  },

  /**
   * Tuples with at least one outbox row the drain worker could send or reclaim
   * this pass: a due `pending` row OR a `claimed` row (a crashed worker's lease
   * the drain reclaims). Mirrors the `idx_outbox_due` partial index predicate.
   */
  async enumerateOutboxTenants(): Promise<TenantAgentRow[]> {
    const result = await db.execute<TenantAgentRow>(sql`
      SELECT DISTINCT tenant_id, agent_id
        FROM outbox_messages
       WHERE tenant_id IS NOT NULL
         AND agent_id IS NOT NULL
         AND (
           (status = 'pending' AND next_attempt_at <= now())
           OR status = 'claimed'
         )
    `);
    return Array.from(result.rows as unknown as TenantAgentRow[]);
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
        'id' | 'created_at' | 'status' | 'attempts' | 'next_attempt_at' | 'tenant_id' | 'agent_id'
      >,
    ) => Promise<OutboxMessage | null>;
  };
};

function txRepos(tx: Tx): TxScopedRepos {
  // The transactional repos run inside the engine's per-occurrence advance,
  // which is itself inside the routed tenant context. Resolve the scope once
  // for the whole transaction; every write below carries it.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
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
        // Fail-loud: the engine holds a claim on this occurrence under THIS
        // tenant, so a 0-row update means the tenant/agent predicate didn't
        // match the claimed row — a routing/context bug, not a benign race.
        const res = await tx
          .update(occurrencesTable)
          .set(update)
          .where(
            and(
              eq(occurrencesTable.id, id),
              eq(occurrencesTable.tenant_id, tenant_id),
              eq(occurrencesTable.agent_id, agent_id),
            ),
          )
          .returning({ id: occurrencesTable.id });
        assertMutated(res.length, 'tx.occurrences.setStatus', { id, tenant_id, agent_id });
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
        const res = await tx
          .update(tasksTable)
          .set(update)
          .where(
            and(
              eq(tasksTable.id, id),
              eq(tasksTable.tenant_id, tenant_id),
              eq(tasksTable.agent_id, agent_id),
            ),
          )
          .returning({ id: tasksTable.id });
        assertMutated(res.length, 'tx.tasks.setStatus', { id, tenant_id, agent_id });
      },
    },
    outbox: {
      async enqueue(input): Promise<OutboxMessage | null> {
        try {
          const rows = await tx
            .insert(outboxTable)
            .values({
              tenant_id,
              agent_id,
              channel_id: await resolveOutboxChannelId(input.kind, input.channel_id),
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.id, id),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Claim up to `limit` due occurrences in one transaction using
   * `FOR UPDATE SKIP LOCKED`. Returns the claimed rows already stamped
   * with the worker_id and claimed_at.
   *
   * Scoped to the routed tenant/agent: the engine tick runs per-tenant, so a
   * tick for tenant A must never claim tenant B's due occurrences. The re-fetch
   * also carries the tenant/agent predicate (belt-and-suspenders — the ids
   * already came from the scoped CTE).
   */
  async claimDue(worker_id: string, limit: number): Promise<Occurrence[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM occurrences
         WHERE status = 'pending' AND scheduled_for <= now()
           AND ${tenantFilter(tenant_id, agent_id)}
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
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          inArray(occurrencesTable.id, ids),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
        ),
      );
  },

  /**
   * Reclaim leases that expired without completing — another worker crashed
   * mid-advance. Resets the row to `pending` and clears `claimed_by`/`claimed_at`
   * so the next `claimDue` pass picks it up normally; the `FOR UPDATE SKIP LOCKED`
   * + status flip already prevents double-handling within a tick. (`_worker_id`
   * is accepted for call-site symmetry with `claimDue` but unused — reclaim
   * releases the lease rather than reassigning it.)
   *
   * Returns the IDs so the caller can audit the recovery, but the caller
   * should NOT process them directly — they're back in the pending queue.
   */
  async reclaimExpiredLeases(_worker_id: string, ttl_seconds: number, limit: number): Promise<string[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db.execute<{ id: string }>(sql`
      WITH expired AS (
        SELECT id FROM occurrences
         WHERE status = 'claimed'
           AND claimed_at < now() - (${ttl_seconds} || ' seconds')::interval
           AND ${tenantFilter(tenant_id, agent_id)}
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
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
    // Fail-loud on 0 rows: every caller transitions an occurrence it just read
    // under THIS tenant context, so a miss is a cross-tenant/lost-context bug.
    const res = await db
      .update(occurrencesTable)
      .set(update)
      .where(
        and(
          eq(occurrencesTable.id, id),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
        ),
      )
      .returning({ id: occurrencesTable.id });
    assertMutated(res.length, 'occurrences.setStatus', { id, tenant_id, agent_id });
  },

  /**
   * Release a claim WITHOUT advancing — returns the row to `pending` so the
   * next tick retries. Used when the engine defers an advance due to a
   * runtime gate (exclusive_per_destinatario collision, missing conversa).
   */
  async releaseClaim(id: string, defer_seconds = 60): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await db
      .update(occurrencesTable)
      .set({
        status: 'pending',
        claimed_by: null,
        claimed_at: null,
        scheduled_for: sql`GREATEST(scheduled_for, now() + (${defer_seconds} || ' seconds')::interval)`,
      })
      .where(
        and(
          eq(occurrencesTable.id, id),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
        ),
      )
      .returning({ id: occurrencesTable.id });
    assertMutated(res.length, 'occurrences.releaseClaim', { id, tenant_id, agent_id });
  },

  /**
   * Codex review #105 round-2 (high): release only the lease (claimed_by /
   * claimed_at) while keeping `status='in_progress'`. Used by the engine
   * when an in_progress occurrence is waiting on an external resource
   * (outbox-drain finishing a forward send) and must NOT regress to
   * `pending` — otherwise the next `claimDue` tick would re-run the
   * outreach initial step and silently rewind progress.
   *
   * The next `claimInProgressForAdvance` tick re-picks it up via the
   * `claimed_at IS NULL OR claimed_at < now() - 30s` predicate.
   */
  async releaseLeaseOnly(id: string): Promise<void> {
    // Scoped to tenant/agent. NOT fail-loud: the `status='in_progress'`
    // predicate makes a 0-row outcome a legitimate concurrent-transition race
    // (the occurrence already moved off in_progress), not a tenant miss.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(occurrencesTable)
      .set({
        claimed_by: null,
        claimed_at: null,
      })
      .where(
        and(
          eq(occurrencesTable.id, id),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          eq(occurrencesTable.status, 'in_progress'),
        ),
      );
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Scope BOTH sides of the join: the occurrence AND its series must belong
    // to the routed tenant/agent (the join is additionally fenced on matching
    // tenant/agent so a cross-tenant series_id collision can't leak a row).
    const rows = await db.execute<{ id: string }>(sql`
      WITH eligible AS (
        SELECT o.id
          FROM occurrences o
          JOIN series s
            ON s.id = o.series_id
           AND s.tenant_id = o.tenant_id
           AND s.agent_id = o.agent_id
         WHERE o.status = 'in_progress'
           AND s.tipo = 'recurring_outreach'
           AND o.tenant_id = ${tenant_id}
           AND o.agent_id = ${agent_id}
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
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          inArray(occurrencesTable.id, ids),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
        ),
      );
  },

  /**
   * For `recurring_outreach`, scan `awaiting_third_party` rows whose
   * wait window expired so the engine can escalate to the owner.
   */
  async listAwaitingTimedOut(limit: number): Promise<Occurrence[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          eq(occurrencesTable.status, 'awaiting_third_party'),
          sql`(contexto_snapshot->>'wait_response_hours') IS NOT NULL`,
          sql`started_at IS NOT NULL`,
          sql`started_at + ((contexto_snapshot->>'wait_response_hours')::int || ' hours')::interval < now()`,
        ),
      )
      .limit(limit);
  },

  async listOverdueForSeries(series_id: string, threshold_at: Date): Promise<Occurrence[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.series_id, series_id),
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          eq(occurrencesTable.status, 'pending'),
          sql`scheduled_for < ${threshold_at}`,
        ),
      )
      .orderBy(occurrencesTable.scheduled_for);
  },

  async findActiveByCorrelation(token: string): Promise<Occurrence | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          eq(occurrencesTable.correlation_token, token),
          inArray(occurrencesTable.status, ['awaiting_third_party', 'in_progress']),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listAwaitingForDestinatario(destinatario_pessoa_id: string): Promise<Occurrence[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          eq(occurrencesTable.status, 'awaiting_third_party'),
          sql`(contexto_snapshot->>'destinatario_pessoa_id') = ${destinatario_pessoa_id}`,
        ),
      )
      .orderBy(desc(occurrencesTable.scheduled_for));
  },

  async hasOpenForDestinatario(series_id: string, destinatario_pessoa_id: string): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ id: occurrencesTable.id })
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ id: occurrencesTable.id })
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(occurrencesTable)
      .where(
        and(
          eq(occurrencesTable.tenant_id, tenant_id),
          eq(occurrencesTable.agent_id, agent_id),
          inArray(occurrencesTable.status, statuses),
        ),
      )
      .limit(limit);
  },
};

export const tasksRepo = {
  async byOccurrence(occurrence_id: string): Promise<Task[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.occurrence_id, occurrence_id),
          eq(tasksTable.tenant_id, tenant_id),
          eq(tasksTable.agent_id, agent_id),
        ),
      )
      .orderBy(tasksTable.ordem);
  },

  async setStatus(
    id: string,
    status: TaskStatus,
    result_patch?: Record<string, unknown>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
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
    // Fail-loud on 0 rows: the caller (engine / outbox-drain) just read this
    // task under the SAME context, so a miss is a cross-tenant/lost-context bug.
    const res = await db
      .update(tasksTable)
      .set(update)
      .where(
        and(
          eq(tasksTable.id, id),
          eq(tasksTable.tenant_id, tenant_id),
          eq(tasksTable.agent_id, agent_id),
        ),
      )
      .returning({ id: tasksTable.id });
    assertMutated(res.length, 'tasks.setStatus', { id, tenant_id, agent_id });
  },
};

export const outboxRepo = {
  async enqueue(input: Omit<OutboxMessageInsert, 'id' | 'created_at' | 'status' | 'attempts' | 'next_attempt_at' | 'tenant_id' | 'agent_id'>): Promise<OutboxMessage | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    try {
      const rows = await db
        .insert(outboxTable)
        .values({
          tenant_id,
          agent_id,
          channel_id: await resolveOutboxChannelId(input.kind, input.channel_id),
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM outbox_messages
         WHERE status = 'pending' AND next_attempt_at <= now()
           AND ${tenantFilter(tenant_id, agent_id)}
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
    return db
      .select()
      .from(outboxTable)
      .where(
        and(
          inArray(outboxTable.id, ids),
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
        ),
      );
  },

  async reclaimExpiredLeases(_worker_id: string, ttl_seconds: number, limit: number): Promise<string[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db.execute<{ id: string }>(sql`
      WITH expired AS (
        SELECT id FROM outbox_messages
         WHERE status = 'claimed'
           AND claimed_at < now() - (${ttl_seconds} || ' seconds')::interval
           AND ${tenantFilter(tenant_id, agent_id)}
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
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await db
      .update(outboxTable)
      .set({ status: 'sent', sent_at: new Date(), last_error: null })
      .where(
        and(
          eq(outboxTable.id, id),
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
        ),
      )
      .returning({ id: outboxTable.id });
    // Fail-loud: the drain worker just claimed this row under THIS context; a
    // 0-row markSent means the tenant/agent predicate missed the claimed row.
    assertMutated(res.length, 'outbox.markSent', { id, tenant_id, agent_id });
  },

  async markFailedRetryable(id: string, error: string, backoff_seconds: number): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await db
      .update(outboxTable)
      .set({
        status: 'pending',
        last_error: error,
        attempts: sql`${outboxTable.attempts} + 1`,
        next_attempt_at: sql`now() + (${backoff_seconds} || ' seconds')::interval`,
        claimed_by: null,
        claimed_at: null,
      })
      .where(
        and(
          eq(outboxTable.id, id),
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
        ),
      )
      .returning({ id: outboxTable.id });
    assertMutated(res.length, 'outbox.markFailedRetryable', { id, tenant_id, agent_id });
  },

  async markDead(id: string, error: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await db
      .update(outboxTable)
      .set({
        status: 'dead',
        last_error: error,
        attempts: sql`${outboxTable.attempts} + 1`,
      })
      .where(
        and(
          eq(outboxTable.id, id),
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
        ),
      )
      .returning({ id: outboxTable.id });
    assertMutated(res.length, 'outbox.markDead', { id, tenant_id, agent_id });
  },

  async returnToPending(id: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await db
      .update(outboxTable)
      .set({ status: 'pending', claimed_by: null, claimed_at: null })
      .where(
        and(
          eq(outboxTable.id, id),
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
        ),
      )
      .returning({ id: outboxTable.id });
    assertMutated(res.length, 'outbox.returnToPending', { id, tenant_id, agent_id });
  },

  async byStatus(status: OutboxStatus, limit = 100): Promise<OutboxMessage[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(outboxTable)
      .where(
        and(
          eq(outboxTable.tenant_id, tenant_id),
          eq(outboxTable.agent_id, agent_id),
          eq(outboxTable.status, status),
        ),
      )
      .limit(limit);
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
