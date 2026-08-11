/**
 * Issue #355 — cross-tenant isolation for the Spec-18 scheduling repos.
 *
 * Proves the inviolable Maia invariant for series / occurrences / tasks /
 * outbox_messages: tenant A can neither READ nor MUTATE tenant B's rows, and a
 * mutation that would touch the wrong tenant FAILS LOUD (or no-ops for the
 * genuinely-conditional cancel/insert guards) and leaves B's rows untouched
 * (revert-check).
 *
 * Strategy (mirrors `tests/unit/outbound-messages-sweeper.spec.ts`): a small
 * in-memory row store backs a `db`/`withTx` mock. The mock interprets the
 * Drizzle query-builder by RENDERING each `.where(...)` fragment to SQL+params
 * via `PgDialect` and extracting the `col = $n` / `col IN (...)` predicates —
 * the same column/value pairs the repo asked Postgres to filter on. So if a
 * repo method forgot to add `tenant_id = $ctx AND agent_id = $ctx`, the store
 * would return the foreign row and the isolation assertions would FAIL. This is
 * a behavioural test of the scoping, not a string-match on the source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory store (hoisted so the vi.mock factory below can close over it).
// The factory itself builds the builder mock with a lazily-imported drizzle
// dialect + getTableName, so no drizzle import is needed at hoist time.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string; tenant_id: string; agent_id: string };
const { store, executeMock } = vi.hoisted(() => ({
  store: {
    series: [] as Array<Record<string, unknown>>,
    occurrences: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<Record<string, unknown>>,
    outbox_messages: [] as Array<Record<string, unknown>>,
  } as Record<string, Array<Record<string, unknown>>>,
  executeMock: vi.fn(async () => ({ rows: [] as unknown[] })),
}));

vi.mock('../../src/db/client.js', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { getTableName } = await import('drizzle-orm');
  const dialect = new PgDialect();

  // Render a Drizzle WHERE fragment and extract equality + IN predicates as a
  // `{ column: value | value[] }` map. Each entry is a filter the repo asked
  // the DB to apply, so a missing tenant_id/agent_id predicate is observable
  // here (the foreign row would match and leak).
  function extractPredicates(where: unknown): Record<string, unknown> {
    if (!where) return {};
    const { sql: text, params } = dialect.sqlToQuery(where as never);
    const preds: Record<string, unknown> = {};
    const eqRe = /"[a-z_]+"\."([a-z_]+)"\s*=\s*\$(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = eqRe.exec(text)) !== null) preds[m[1]!] = params[Number(m[2]) - 1];
    const inRe = /"[a-z_]+"\."([a-z_]+)"\s+in\s*\(([^)]*)\)/gi;
    while ((m = inRe.exec(text)) !== null) {
      const slots = m[2]!.match(/\$(\d+)/g) ?? [];
      preds[m[1]!] = slots.map((s) => params[Number(s.slice(1)) - 1]);
    }
    return preds;
  }
  function rowMatches(row: Record<string, unknown>, preds: Record<string, unknown>): boolean {
    for (const [col, val] of Object.entries(preds)) {
      if (Array.isArray(val)) {
        if (!val.includes(row[col])) return false;
      } else if (row[col] !== val) {
        return false;
      }
    }
    return true;
  }

  function selectBuilder() {
    let table: string | null = null;
    let where: unknown;
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as never);
        return builder;
      },
      where(w: unknown) {
        where = w;
        return builder;
      },
      orderBy: () => builder,
      limit: () => runSelect(),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(runSelect()).then(resolve),
    };
    function runSelect(): Array<Record<string, unknown>> {
      if (!table || !store[table]) return [];
      const preds = extractPredicates(where);
      return store[table]!.filter((r) => rowMatches(r, preds));
    }
    return builder;
  }

  function insertBuilder(t: unknown) {
    const table = getTableName(t as never);
    let values: Array<Record<string, unknown>> = [];
    return {
      values(v: Record<string, unknown> | Array<Record<string, unknown>>) {
        values = Array.isArray(v) ? v : [v];
        return this;
      },
      returning() {
        const inserted = values.map((v, i) => ({
          ...v,
          id: (v.id as string) ?? `gen-${table}-${(store[table]?.length ?? 0) + i + 1}`,
        }));
        if (store[table]) store[table]!.push(...inserted);
        return Promise.resolve(inserted);
      },
    };
  }

  function updateBuilder(t: unknown) {
    const table = getTableName(t as never);
    let patch: Record<string, unknown> = {};
    let where: unknown;
    return {
      set(p: Record<string, unknown>) {
        patch = p;
        return this;
      },
      where(w: unknown) {
        where = w;
        return this;
      },
      returning() {
        if (!store[table]) return Promise.resolve([]);
        const preds = extractPredicates(where);
        const matched = store[table]!.filter((r) => rowMatches(r, preds));
        for (const r of matched) {
          for (const [k, v] of Object.entries(patch)) {
            // Skip raw SQL exprs (version bump, jsonb merge, GREATEST) — the
            // isolation test only needs row identity + plain-value columns.
            if (v !== null && typeof v === 'object' && 'queryChunks' in (v as object)) continue;
            r[k] = v as unknown;
          }
        }
        // Return the full mutated rows (Drizzle `.returning()` with no column
        // selection returns all columns; `.returning({ id })` callers just read
        // `.length` / `.id`, both satisfied by the full row).
        return Promise.resolve(matched.map((r) => ({ ...r })));
      },
    };
  }

  const dbMock = {
    select: () => selectBuilder(),
    insert: (t: unknown) => insertBuilder(t),
    update: (t: unknown) => updateBuilder(t),
    execute: executeMock,
  };
  return {
    db: dbMock,
    withTx: async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
  };
});

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Fase 0 (spec roteamento v4 §1.6): `outboxRepo.enqueue` for whatsapp% kinds
// without an explicit channel_id resolves the caller agent's SOLE active
// channel (ALS-scoped) and stamps it on the row. The store-mock has no
// `channels` table, so stub the resolver to a deterministic single channel —
// the isolation-under-test (tenant/agent stamping) is unchanged.
// vi.hoisted: the factory runs during the static import of scheduling/repos.js
// below, before plain top-level consts would be initialised.
const { soleChannelMock } = vi.hoisted(() => ({
  soleChannelMock: vi.fn(async () => ({ kind: 'one' as const, id: 'chan-sole-1' })),
}));
vi.mock('../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { findSoleActiveForCurrentAgent: soleChannelMock },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { runWithTenantContext } from '../../src/db/tenant-context.js';
const _dialect = new PgDialect();
import {
  seriesRepo,
  occurrencesRepo,
  tasksRepo,
  outboxRepo,
} from '../../src/scheduling/repos.js';

const A = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

function seedSeries(over: Partial<Row> & Pick<Row, 'id' | 'tenant_id' | 'agent_id'>): Row {
  const row = { status: 'active', version: 1, tipo: 'recurring_payment', rrule: null, ...over } as Row;
  store.series!.push(row);
  return row;
}
function seedOcc(over: Partial<Row> & Pick<Row, 'id' | 'tenant_id' | 'agent_id' | 'series_id'>): Row {
  const row = {
    status: 'pending',
    scheduled_for: new Date(),
    correlation_token: null,
    contexto_snapshot: {},
    ...over,
  } as Row;
  store.occurrences!.push(row);
  return row;
}
function seedTask(over: Partial<Row> & Pick<Row, 'id' | 'tenant_id' | 'agent_id' | 'occurrence_id'>): Row {
  const row = { status: 'pending', kind: 'fire_reminder', ordem: 1, ...over } as Row;
  store.tasks!.push(row);
  return row;
}
function seedOutbox(over: Partial<Row> & Pick<Row, 'id' | 'tenant_id' | 'agent_id'>): Row {
  const row = { status: 'pending', kind: 'whatsapp_text', payload: {}, attempts: 0, ...over } as Row;
  store.outbox_messages!.push(row);
  return row;
}

beforeEach(() => {
  store.series!.length = 0;
  store.occurrences!.length = 0;
  store.tasks!.length = 0;
  store.outbox_messages!.length = 0;
  executeMock.mockClear().mockResolvedValue({ rows: [] });
  soleChannelMock.mockClear();
});

// ---------------------------------------------------------------------------
// READS — A cannot see B's rows
// ---------------------------------------------------------------------------
describe('scheduling tenant isolation — reads', () => {
  it('seriesRepo.findById: A cannot read B-owned series', async () => {
    seedSeries({ id: 's-b', ...B });
    const asA = await runWithTenantContext(A, () => seriesRepo.findById('s-b'));
    expect(asA).toBeNull();
    const asB = await runWithTenantContext(B, () => seriesRepo.findById('s-b'));
    expect(asB?.id).toBe('s-b');
  });

  it('occurrencesRepo.byId: A cannot read B-owned occurrence', async () => {
    seedOcc({ id: 'o-b', series_id: 's-b', ...B });
    const asA = await runWithTenantContext(A, () => occurrencesRepo.byId('o-b'));
    expect(asA).toBeNull();
    const asB = await runWithTenantContext(B, () => occurrencesRepo.byId('o-b'));
    expect(asB?.id).toBe('o-b');
  });

  it('occurrencesRepo.findActiveByCorrelation: a shared token never crosses tenants', async () => {
    // Same correlation token under both tenants (tokens are only 4 hex chars —
    // collisions across tenants are realistic). A must only ever see its own.
    seedOcc({ id: 'o-a', series_id: 's-a', ...A, status: 'awaiting_third_party', correlation_token: 'A4F2' });
    seedOcc({ id: 'o-b', series_id: 's-b', ...B, status: 'awaiting_third_party', correlation_token: 'A4F2' });
    const asA = await runWithTenantContext(A, () => occurrencesRepo.findActiveByCorrelation('A4F2'));
    expect(asA?.id).toBe('o-a');
    const asB = await runWithTenantContext(B, () => occurrencesRepo.findActiveByCorrelation('A4F2'));
    expect(asB?.id).toBe('o-b');
  });

  it('tasksRepo.byOccurrence: A cannot read tasks of a B-owned occurrence', async () => {
    seedTask({ id: 't-b', occurrence_id: 'o-b', ...B });
    const asA = await runWithTenantContext(A, () => tasksRepo.byOccurrence('o-b'));
    expect(asA).toHaveLength(0);
    const asB = await runWithTenantContext(B, () => tasksRepo.byOccurrence('o-b'));
    expect(asB).toHaveLength(1);
  });

  it('outboxRepo.byStatus: A only sees its own pending rows', async () => {
    seedOutbox({ id: 'ob-a', ...A, status: 'pending' });
    seedOutbox({ id: 'ob-b', ...B, status: 'pending' });
    const asA = await runWithTenantContext(A, () => outboxRepo.byStatus('pending'));
    expect(asA.map((r) => r.id)).toEqual(['ob-a']);
  });

  it('every read OUTSIDE a tenant context throws MissingTenantContextError', async () => {
    const { MissingTenantContextError } = await import('../../src/db/tenant-context.js');
    await expect(seriesRepo.findById('x')).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(occurrencesRepo.byId('x')).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(tasksRepo.byOccurrence('x')).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(outboxRepo.byStatus('pending')).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});

// ---------------------------------------------------------------------------
// WRITES — INSERTs carry the caller's tenant/agent
// ---------------------------------------------------------------------------
describe('scheduling tenant isolation — inserts stamp the caller tenant', () => {
  it('createWithFirstOccurrence stamps tenant/agent on series, occurrence AND tasks', async () => {
    await runWithTenantContext(A, () =>
      seriesRepo.createWithFirstOccurrence({
        tipo: 'one_shot_reminder',
        status: 'active',
        rrule: null,
        one_shot_at: null,
        month_end_policy: 'skip_invalid_month',
        missed_run_policy: 'fire_latest_only',
        staleness_threshold_hours: 24,
        exclusive_per_destinatario: false,
        contexto_template: {},
        entidade_id: null,
        owner_pessoa_id: 'owner-a',
        initial_occurrence: {
          scheduled_for: new Date(),
          contexto_snapshot: { texto: 'oi', canal: 'whatsapp' } as never,
          tasks: [{ ordem: 1, kind: 'fire_reminder' }],
        },
      }),
    );
    expect(store.series[0]).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-A' });
    expect(store.occurrences[0]).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-A' });
    expect(store.tasks[0]).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-A' });
  });

  it('outboxRepo.enqueue stamps the caller tenant/agent', async () => {
    await runWithTenantContext(B, () =>
      outboxRepo.enqueue({
        occurrence_id: null,
        task_id: null,
        kind: 'whatsapp_text',
        payload: { jid: 'x', text: 'y' } as never,
        dedup_key: 'k1',
      }),
    );
    expect(store.outbox_messages[0]).toMatchObject({
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      // Fase 0: whatsapp rows are born WITH the resolved channel (090 CHECK).
      channel_id: 'chan-sole-1',
    });
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS — A cannot mutate B's rows; B's rows survive (revert-check)
// ---------------------------------------------------------------------------
describe('scheduling tenant isolation — mutations fail loud + revert-check', () => {
  it('occurrencesRepo.setStatus: A mutating a B occurrence FAILS LOUD and leaves B untouched', async () => {
    seedOcc({ id: 'o-b', series_id: 's-b', ...B, status: 'pending' });
    await expect(
      runWithTenantContext(A, () => occurrencesRepo.setStatus('o-b', 'completed')),
    ).rejects.toThrow(/matched 0 rows|cross-tenant/i);
    // Revert-check: B's row is still pending.
    expect(store.occurrences!.find((r) => r.id === 'o-b')!.status).toBe('pending');
    // Sanity: B CAN mutate its own row.
    await runWithTenantContext(B, () => occurrencesRepo.setStatus('o-b', 'completed'));
    expect(store.occurrences!.find((r) => r.id === 'o-b')!.status).toBe('completed');
  });

  it('tasksRepo.setStatus: A mutating a B task FAILS LOUD and leaves B untouched', async () => {
    seedTask({ id: 't-b', occurrence_id: 'o-b', ...B, status: 'pending' });
    await expect(
      runWithTenantContext(A, () => tasksRepo.setStatus('t-b', 'completed')),
    ).rejects.toThrow(/matched 0 rows|cross-tenant/i);
    expect(store.tasks!.find((r) => r.id === 't-b')!.status).toBe('pending');
  });

  it('outboxRepo.markSent: A marking a B outbox row FAILS LOUD and leaves B untouched', async () => {
    seedOutbox({ id: 'ob-b', ...B, status: 'claimed' });
    await expect(
      runWithTenantContext(A, () => outboxRepo.markSent('ob-b')),
    ).rejects.toThrow(/matched 0 rows|cross-tenant/i);
    expect(store.outbox_messages!.find((r) => r.id === 'ob-b')!.status).toBe('claimed');
    await runWithTenantContext(B, () => outboxRepo.markSent('ob-b'));
    expect(store.outbox_messages!.find((r) => r.id === 'ob-b')!.status).toBe('sent');
  });

  it('outboxRepo.markDead / markFailedRetryable / returnToPending: A cannot mutate B', async () => {
    seedOutbox({ id: 'ob-b', ...B, status: 'claimed' });
    await expect(runWithTenantContext(A, () => outboxRepo.markDead('ob-b', 'e'))).rejects.toThrow(
      /matched 0 rows|cross-tenant/i,
    );
    await expect(
      runWithTenantContext(A, () => outboxRepo.markFailedRetryable('ob-b', 'e', 30)),
    ).rejects.toThrow(/matched 0 rows|cross-tenant/i);
    await expect(runWithTenantContext(A, () => outboxRepo.returnToPending('ob-b'))).rejects.toThrow(
      /matched 0 rows|cross-tenant/i,
    );
    // Untouched.
    expect(store.outbox_messages!.find((r) => r.id === 'ob-b')!.status).toBe('claimed');
  });

  it('occurrencesRepo.releaseClaim: A cannot release a B claim (fail loud, revert-check)', async () => {
    seedOcc({ id: 'o-b', series_id: 's-b', ...B, status: 'claimed', claimed_by: 'w-b' });
    await expect(
      runWithTenantContext(A, () => occurrencesRepo.releaseClaim('o-b', 60)),
    ).rejects.toThrow(/matched 0 rows|cross-tenant/i);
    expect(store.occurrences!.find((r) => r.id === 'o-b')!.status).toBe('claimed');
  });

  it('seriesRepo.cancelAtomic: A cancelling a B series is a no-op not_found (B series survives)', async () => {
    seedSeries({ id: 's-b', ...B, status: 'active', version: 1 });
    seedOcc({ id: 'o-b', series_id: 's-b', ...B, status: 'pending' });
    // A's cancel scopes to A — the B series is invisible → series=null,
    // reported as not_found by the tool. NOT fail-loud (legitimate "no such
    // series in MY tenant"); the key invariant is B is untouched.
    const res = await runWithTenantContext(A, () => seriesRepo.cancelAtomic('s-b', 'attacker'));
    expect(res.series).toBeNull();
    expect(res.cancelled_occurrence_ids).toEqual([]);
    // Revert-check: B's series + occurrence are still active/pending.
    expect(store.series!.find((r) => r.id === 's-b')!.status).toBe('active');
    expect(store.occurrences!.find((r) => r.id === 'o-b')!.status).toBe('pending');
    // B can cancel its own series.
    const okB = await runWithTenantContext(B, () => seriesRepo.cancelAtomic('s-b', 'owner-b'));
    expect(okB.series?.status).toBe('cancelled');
    expect(store.occurrences!.find((r) => r.id === 'o-b')!.status).toBe('cancelled');
  });

  it('seriesRepo.insertNextOccurrenceIfActive: A cannot satisfy the guard against a B series', async () => {
    seedSeries({ id: 's-b', ...B, status: 'active', version: 1 });
    // Under A, the guard SELECT (scoped to A) finds no active s-b → no insert.
    const res = await runWithTenantContext(A, () =>
      seriesRepo.insertNextOccurrenceIfActive({
        series_id: 's-b',
        expected_version: 1,
        scheduled_for: new Date(),
        contexto_snapshot: { texto: 'x', canal: 'whatsapp' } as never,
        tasks: [{ ordem: 1, kind: 'fire_reminder' }],
      }),
    );
    expect(res.occurrence).toBeNull();
    // No occurrence was inserted under A for the B series.
    expect(store.occurrences!.filter((r) => r.series_id === 's-b')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DISPATCHER ENUMERATIONS run OUTSIDE context and surface every real tuple
// ---------------------------------------------------------------------------
describe('scheduling tenant isolation — dispatcher enumerations', () => {
  it('enumerate* helpers issue tenant_id/agent_id IS NOT NULL DISTINCT scans (belt-and-suspenders)', async () => {
    const { schedulingDispatch } = await import('../../src/scheduling/repos.js');
    const captured: string[] = [];
    executeMock.mockImplementation(async (q: unknown) => {
      captured.push(_dialect.sqlToQuery(q as SQL).sql);
      return { rows: [] as unknown[] };
    });
    await schedulingDispatch.enumerateTickTenants();
    await schedulingDispatch.enumerateActiveSeriesTenants();
    await schedulingDispatch.enumerateOutboxTenants();
    expect(captured).toHaveLength(3);
    for (const s of captured) {
      expect(s).toMatch(/SELECT\s+DISTINCT/i);
      expect(s).toMatch(/tenant_id\s+IS\s+NOT\s+NULL/i);
      expect(s).toMatch(/agent_id\s+IS\s+NOT\s+NULL/i);
    }
  });
});

// ---------------------------------------------------------------------------
// RAW-CTE CLAIM/RECLAIM PATHS — the `db.execute(sql`…`)` hot paths (#355 Gap A)
// ---------------------------------------------------------------------------
//
// The behavioural store-mock above renders Drizzle query-builder `.where(...)`
// fragments and so catches a dropped tenant predicate on every builder-based
// read/write. But the FOR UPDATE SKIP LOCKED claim/reclaim CTEs do NOT go
// through the builder — they are hand-written `db.execute(sql`…`)` strings, and
// the store-mock returns `{ rows: [] }` for `db.execute` WITHOUT ever inspecting
// the SQL. A future edit dropping `${tenantFilter(...)}` from a CTE (or the
// tenant-fenced occurrence↔series join) would therefore pass every other test
// in this file silently — a cross-tenant claim leak.
//
// These tests close that hole: they capture the literal SQL text each of the 5
// claim/reclaim methods hands to `db.execute`, render it via the same PgDialect
// the repo uses, and assert the rendered predicate carries BOTH the `tenant_id`
// and `agent_id` filter (params `$N`, since `tenantFilter` interpolates the ALS
// values as bind params). Removing a tenant predicate from any CTE makes the
// corresponding assertion FAIL — the executable backstop the mock alone lacks.
//
// `db.execute` returns `{ rows: [] }`, so each method's `ids.length === 0`
// early-return skips the (separately-covered, builder-based) re-fetch SELECT;
// the single captured statement per call is the claim/reclaim CTE itself.
describe('scheduling tenant isolation — raw-CTE claim/reclaim predicates (Gap A)', () => {
  /** Capture every SQL string `db.execute` receives, rendered to text. */
  async function captureSql(fn: () => Promise<unknown>): Promise<string[]> {
    const captured: string[] = [];
    executeMock.mockImplementation(async (q: unknown) => {
      captured.push(_dialect.sqlToQuery(q as SQL).sql);
      return { rows: [] as unknown[] };
    });
    await runWithTenantContext(A, fn);
    return captured;
  }

  // The exact tenant-predicate substrings asserted below (whitespace-tolerant).
  // `tenantFilter(t, a)` => `tenant_id = $N AND agent_id = $M`.
  const TENANT_EQ = /tenant_id\s*=\s*\$\d+/i;
  const AGENT_EQ = /agent_id\s*=\s*\$\d+/i;

  it('occurrencesRepo.claimDue CTE is fenced to tenant_id + agent_id', async () => {
    const [cte, ...rest] = await captureSql(() => occurrencesRepo.claimDue('w-A', 10));
    expect(rest).toHaveLength(0); // ids empty → no re-fetch SELECT executed
    expect(cte).toMatch(/FOR UPDATE SKIP LOCKED/i); // sanity: this is the claim CTE
    // Proof: the lock-and-update set is scoped to the routed tenant/agent, so a
    // tick for tenant A can never claim tenant B's due occurrences.
    expect(cte).toMatch(TENANT_EQ);
    expect(cte).toMatch(AGENT_EQ);
  });

  it('occurrencesRepo.reclaimExpiredLeases CTE is fenced to tenant_id + agent_id', async () => {
    const [cte] = await captureSql(() => occurrencesRepo.reclaimExpiredLeases('w-A', 300, 10));
    expect(cte).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Proof: a lease-reaper pass for tenant A never resets tenant B's expired
    // claims back to pending.
    expect(cte).toMatch(TENANT_EQ);
    expect(cte).toMatch(AGENT_EQ);
  });

  it('occurrencesRepo.claimInProgressForAdvance scopes the occurrence AND tenant-fences the series join', async () => {
    const [cte, ...rest] = await captureSql(() =>
      occurrencesRepo.claimInProgressForAdvance('w-A', 10),
    );
    expect(rest).toHaveLength(0); // ids empty → no re-fetch SELECT executed
    expect(cte).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Proof (occurrence side): the claim only locks tenant A's in_progress rows.
    expect(cte).toMatch(/o\.tenant_id\s*=\s*\$\d+/i);
    expect(cte).toMatch(/o\.agent_id\s*=\s*\$\d+/i);
    // Proof (join fence): the occurrence↔series JOIN additionally requires
    // matching tenant/agent on BOTH sides, so a cross-tenant series_id
    // collision can't smuggle in a foreign row via the join.
    expect(cte).toMatch(/s\.tenant_id\s*=\s*o\.tenant_id/i);
    expect(cte).toMatch(/s\.agent_id\s*=\s*o\.agent_id/i);
  });

  it('outboxRepo.claimDue CTE is fenced to tenant_id + agent_id', async () => {
    const [cte, ...rest] = await captureSql(() => outboxRepo.claimDue('w-A', 10));
    expect(rest).toHaveLength(0); // ids empty → no re-fetch SELECT executed
    expect(cte).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Proof: the outbox relayer for tenant A never claims tenant B's due rows.
    expect(cte).toMatch(TENANT_EQ);
    expect(cte).toMatch(AGENT_EQ);
  });

  it('outboxRepo.reclaimExpiredLeases CTE is fenced to tenant_id + agent_id', async () => {
    const [cte] = await captureSql(() => outboxRepo.reclaimExpiredLeases('w-A', 300, 10));
    expect(cte).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // Proof: a relayer lease-reaper for tenant A never returns tenant B's
    // expired outbox claims to pending.
    expect(cte).toMatch(TENANT_EQ);
    expect(cte).toMatch(AGENT_EQ);
  });

  // Belt-and-suspenders: a single guard that ALL five raw CTEs carry a tenant
  // AND an agent predicate. This is the test that goes red the instant ANY
  // claim/reclaim CTE loses its `${tenantFilter(...)}` (or the join fence).
  it('every raw claim/reclaim CTE carries a tenant_id AND agent_id predicate', async () => {
    const ctes = [
      ...(await captureSql(() => occurrencesRepo.claimDue('w-A', 10))),
      ...(await captureSql(() => occurrencesRepo.reclaimExpiredLeases('w-A', 300, 10))),
      ...(await captureSql(() => occurrencesRepo.claimInProgressForAdvance('w-A', 10))),
      ...(await captureSql(() => outboxRepo.claimDue('w-A', 10))),
      ...(await captureSql(() => outboxRepo.reclaimExpiredLeases('w-A', 300, 10))),
    ];
    expect(ctes).toHaveLength(5); // exactly one statement per claim/reclaim call
    for (const cte of ctes) {
      expect(cte).toMatch(TENANT_EQ);
      expect(cte).toMatch(AGENT_EQ);
    }
  });
});
