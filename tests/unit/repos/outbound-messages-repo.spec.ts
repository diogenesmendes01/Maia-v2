/**
 * Issue #227 — outboundMessagesRepo unit tests.
 *
 * Pattern: in-memory db fake that emulates the production atomic
 * `INSERT ... ON CONFLICT (tenant_id, agent_id, idempotency_key)
 * DO UPDATE` path. Tests prove:
 *   1. upsertPending atomically inserts a fresh `pending` row when no
 *      prior key exists; the `inserted` flag is true (claim winner).
 *   2. upsertPending returns `skip:true, inserted:false` when a prior
 *      row for the key is already at status='sent'.
 *   3. upsertPending returns `inserted:false` and DOES NOT overwrite
 *      when the prior row is `pending` and NOT stale (the conservative
 *      same-turn race outcome — the other writer holds the claim).
 *   4. upsertPending reclaims a `failed` row (overwrites it with a
 *      fresh `pending`) — pre-send failures are always recoverable.
 *   5. upsertPending reclaims a `pending` row older than
 *      STALE_PENDING_SECONDS (DB drop mid-claim / markSent failure
 *      recovery). The `inserted` flag is false but `status` is reset
 *      to `pending`.
 *   6. markSent / markFailed / markUnknown move the row forward.
 *   7. markFailed / markUnknown REFUSE to degrade `sent` or `unknown`
 *      (CAS — silent no-op via `WHERE status NOT IN (...)`).
 *   8. findByConversaTurn returns the LATEST attempt for the turn.
 *   9. All methods throw without tenant context (MissingTenantContextError).
 *  10. CROSS-TENANT: a row inserted under tenant-A is invisible from
 *      tenant-B context (the inviolable tenant isolation invariant).
 *      Both insertion orders (A-first AND B-first) are exercised
 *      adversarially per the PR #222 pattern. The UNIQUE is composite
 *      `(tenant_id, agent_id, idempotency_key)` so cross-tenant key
 *      reuse is physically allowed (different rows).
 *  11. AGENT scope: rows are filtered by `agent_id` too — a tenant-A
 *      / agent-X row is invisible from tenant-A / agent-Y context.
 *  12. CONCURRENT claims: two Promise.all upserts for the same key
 *      resolve to exactly one `inserted:true` (atomic claim winner).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + drizzle/db fakes
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const store = new Map<unknown, Row[]>();

function tableOf(t: unknown): Row[] {
  if (!store.has(t)) store.set(t, []);
  return store.get(t)!;
}

type Pred = (row: Row) => boolean;
interface PredObj {
  __pred: Pred;
}
function isPredObj(x: unknown): x is PredObj {
  return !!x && typeof x === 'object' && '__pred' in (x as object);
}
interface ColRef {
  __col: string;
}
function isColRef(x: unknown): x is ColRef {
  return !!x && typeof x === 'object' && '__col' in (x as object);
}
interface SortKey {
  __sortKey: (row: Row) => number;
  __dir?: 'asc' | 'desc';
}
function isSortKey(x: unknown): x is SortKey {
  return !!x && typeof x === 'object' && '__sortKey' in (x as object);
}
interface SqlExpr {
  __sql: true;
  strings: TemplateStringsArray;
  values: unknown[];
}
function isSqlExpr(x: unknown): x is SqlExpr {
  return !!x && typeof x === 'object' && '__sql' in (x as object);
}

// Translate a drizzle `sql\`\`` template into a row predicate by
// pattern-matching the specific shapes this repo uses. Currently only
// `${column} NOT IN ('a', 'b', ...)` is recognised — that's enough for
// the CAS predicates in markFailed/markUnknown.
function sqlExprToPred(expr: SqlExpr): Pred | null {
  const joined = expr.strings.join('?');
  const notInMatch = /NOT\s+IN\s*\(([^)]+)\)/i.exec(joined);
  if (notInMatch && expr.values[0] && isColRef(expr.values[0])) {
    const col = (expr.values[0] as ColRef).__col;
    const literals = notInMatch[1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    return (row: Row) => !literals.includes(String(row[col]));
  }
  return null;
}

vi.mock('drizzle-orm', () => {
  const eq = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] === right;
    },
  });
  const and = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) =>
      conds.every((c) => {
        if (isPredObj(c)) return c.__pred(row);
        if (isSqlExpr(c)) {
          const pred = sqlExprToPred(c);
          if (pred) return pred(row);
        }
        return true;
      }),
  });
  const desc = (col: unknown): SortKey => {
    if (isColRef(col)) {
      const c = col.__col;
      return {
        __sortKey: (row: Row) => {
          const v = row[c];
          if (v == null) return -Infinity;
          if (typeof v === 'number') return v;
          if (v instanceof Date) return v.getTime();
          return Array.from(String(v)).reduce(
            (acc, ch) => acc + ch.charCodeAt(0) / 1e6,
            0,
          );
        },
        __dir: 'desc',
      };
    }
    return { __sortKey: () => 0, __dir: 'desc' };
  };
  // sql template tag — surfaces the raw template so `db.execute` can
  // interpret the upsert command intent without parsing SQL, AND so
  // `and(...)` can translate CAS predicates to row filters.
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): SqlExpr => ({
    __sql: true,
    strings,
    values,
  });
  return { eq, and, desc, sql };
});

function makeTable(): unknown {
  return new Proxy(
    { __tableName: 'outbound_messages' },
    {
      get: (t, prop: string) => {
        if (prop === '__tableName') return (t as Record<string, unknown>)['__tableName'];
        return { __col: prop };
      },
    },
  );
}

vi.mock('@/db/schema.js', () => ({
  outbound_messages: makeTable(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Stale threshold (must match the prod constant). 30 seconds.
const STALE_MS = 30_000;

class SelectBuilder {
  private _table: unknown = null;
  private _pred: Pred = () => true;
  private _limit = Infinity;
  private _sortKeys: SortKey[] = [];

  from(t: unknown) {
    this._table = t;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  orderBy(...args: unknown[]) {
    for (const a of args) {
      if (isSortKey(a)) this._sortKeys.push(a);
    }
    return this;
  }
  limit(n: number) {
    this._limit = n;
    return this;
  }
  private exec(): Row[] {
    let rows = tableOf(this._table).filter(this._pred);
    if (this._sortKeys.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const sk of this._sortKeys) {
          const av = sk.__sortKey(a);
          const bv = sk.__sortKey(b);
          if (av < bv) return sk.__dir === 'desc' ? 1 : -1;
          if (av > bv) return sk.__dir === 'desc' ? -1 : 1;
        }
        return 0;
      });
    }
    return rows.slice(0, this._limit).map((r) => ({ ...r }));
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
}

class UpdateBuilder {
  private _table: unknown = null;
  private _set: Partial<Row> | null = null;
  private _pred: Pred = () => true;
  constructor(t: unknown) {
    this._table = t;
  }
  set(v: Partial<Row>) {
    this._set = v;
    return this;
  }
  where(p: unknown) {
    if (isPredObj(p)) this._pred = p.__pred;
    return this;
  }
  returning(_selector?: unknown) {
    return this;
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      if (!this._set) {
        resolve([]);
        return;
      }
      const rows = tableOf(this._table);
      const updated: Row[] = [];
      for (const r of rows) {
        if (this._pred(r)) {
          Object.assign(r, this._set);
          updated.push({ ...r });
        }
      }
      resolve(updated);
    } catch (e) {
      reject?.(e);
    }
  }
}

// Fake `db.execute` — interprets the upsert SQL template by inspecting
// the values array (tenant_id, agent_id, idempotency_key, conversa_id,
// in_reply_to, stale_seconds). This is a deliberate simplification: it
// only supports the one upsert shape used by the repo. The storage
// key is always the schema's `outbound_messages` proxy so SELECT /
// UPDATE paths share the same table.
let outboundTableRef: unknown = null;
async function getOutboundTable(): Promise<unknown> {
  if (outboundTableRef) return outboundTableRef;
  const schema = await import('@/db/schema.js');
  outboundTableRef = (schema as Record<string, unknown>)['outbound_messages'];
  return outboundTableRef;
}

async function executeUpsert(values: unknown[]): Promise<{ rows: Row[] }> {
  const [tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, _stale_seconds] = values as [
    string,
    string,
    string,
    string,
    string,
    number,
  ];
  const table = await getOutboundTable();
  const rows = tableOf(table);
  const existing = rows.find(
    (r) =>
      r.tenant_id === tenant_id &&
      r.agent_id === agent_id &&
      r.idempotency_key === idempotency_key,
  );
  if (!existing) {
    // INSERT branch — fresh row, xmax=0.
    const row: Row = {
      id: `om-${Math.random().toString(36).slice(2)}`,
      tenant_id,
      agent_id,
      idempotency_key,
      conversa_id,
      in_reply_to,
      provider_message_id: null,
      status: 'pending',
      sent_at: null,
      error: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      was_inserted: true,
    };
    rows.push(row);
    return { rows: [{ ...row }] };
  }
  // ON CONFLICT DO UPDATE — overwrite when (failed) OR
  // (pending AND created_at < now - STALE_MS).
  const isFailed = existing.status === 'failed';
  const createdAt = existing.created_at instanceof Date ? existing.created_at : new Date(existing.created_at as string);
  const isStalePending =
    existing.status === 'pending' && Date.now() - createdAt.getTime() >= STALE_MS;
  if (isFailed || isStalePending) {
    Object.assign(existing, {
      status: 'pending',
      conversa_id,
      in_reply_to,
      provider_message_id: null,
      sent_at: null,
      error: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    return { rows: [{ ...existing, was_inserted: false }] };
  }
  // WHERE filtered the UPDATE out — RETURNING is empty.
  return { rows: [] };
}

// Serialize concurrent `db.execute` calls so the fake mirrors Postgres
// ON CONFLICT serialization: two writers race the INSERT, exactly one
// wins. Without this guard the two microtask-interleaved Promise.all
// calls both observe "no existing" and both insert (real Postgres
// would let one INSERT win and the other hit the conflict branch).
let executeChain: Promise<unknown> = Promise.resolve();
vi.mock('@/db/client.js', () => ({
  db: {
    select: () => new SelectBuilder(),
    update: (t: unknown) => new UpdateBuilder(t),
    execute: (expr: unknown) => {
      const next = executeChain.then(() => {
        if (isSqlExpr(expr)) {
          return executeUpsert(expr.values);
        }
        throw new Error('fake_db.execute_unsupported_expression');
      });
      executeChain = next.catch(() => undefined);
      return next;
    },
  },
}));

import { outboundMessagesRepo, STALE_PENDING_SECONDS } from '@/db/repositories/outbound-messages-repo.js';
import { MissingTenantContextError } from '@/db/tenant-context.js';

const CONV = '00000000-0000-0000-0000-000000000001';
const TURN = '00000000-0000-0000-0000-000000000002';
const KEY = 'tenant-a-test-key-1';

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
});

describe('outboundMessagesRepo — atomic claim + status transitions', () => {
  it('upsertPending inserts a fresh pending row + reports inserted=true', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const res = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(res.inserted).toBe(true);
      expect(res.skip).toBe(false);
      expect(res.row.status).toBe('pending');
      expect(res.row.tenant_id).toBe('tenant-a');
      expect(res.row.agent_id).toBe('agent-a');
      expect(res.row.conversa_id).toBe(CONV);
      expect(res.row.in_reply_to).toBe(TURN);
    });
  });

  it('upsertPending returns skip=true when prior row is status=sent', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-xyz',
        sent_at: new Date(),
      });
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retry.inserted).toBe(false);
      expect(retry.skip).toBe(true);
      expect(retry.row.status).toBe('sent');
      expect(retry.row.provider_message_id).toBe('wa-xyz');
    });
  });

  it('upsertPending does NOT overwrite a recent (non-stale) pending row', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      // Re-claim immediately — must NOT take the row (race: another
      // worker already holds it). `inserted=false`, status still pending.
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retry.inserted).toBe(false);
      expect(retry.skip).toBe(false);
      expect(retry.row.status).toBe('pending');
    });
  });

  it('upsertPending reclaims a `failed` row (overwrites with fresh pending)', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: KEY,
        error: 'jid_resolution_failed',
      });
      // Retry — the `failed` row IS reclaimable. The conflict matched
      // but the DO UPDATE branch overwrote it; inserted=false (not a
      // fresh INSERT) but status reset to pending.
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retry.inserted).toBe(false);
      expect(retry.skip).toBe(false);
      expect(retry.row.status).toBe('pending');
      expect(retry.row.error).toBeNull();
    });
  });

  it('upsertPending reclaims a STALE pending row (>30s old)', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const start = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(start);
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      // Advance 31s — the prior pending row is now stale.
      vi.setSystemTime(start + (STALE_PENDING_SECONDS + 1) * 1000);
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retry.inserted).toBe(false);
      expect(retry.skip).toBe(false);
      expect(retry.row.status).toBe('pending');
      vi.useRealTimers();
    });
  });

  it('markSent transitions pending → sent and records provider id', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      const sentAt = new Date();
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-id-123',
        sent_at: sentAt,
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('sent');
      expect(found?.provider_message_id).toBe('wa-id-123');
      expect(found?.sent_at).toEqual(sentAt);
      expect(found?.error).toBeNull();
    });
  });

  it('markFailed records error and keeps row available for retry', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: KEY,
        error: 'jid_resolution_failed',
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('failed');
      expect(found?.error).toBe('jid_resolution_failed');
      expect(found?.provider_message_id).toBeNull();
    });
  });

  it('markUnknown records ambiguous-throw signal', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markUnknown({
        idempotency_key: KEY,
        error: 'connection_reset_after_relay',
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('unknown');
      expect(found?.error).toBe('connection_reset_after_relay');
    });
  });

  it('markFailed CAS: REFUSES to degrade a `sent` row', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-id-final',
        sent_at: new Date(),
      });
      // A stale background retry tries to mark failed — must NOT take.
      await outboundMessagesRepo.markFailed({
        idempotency_key: KEY,
        error: 'stale_retry_error',
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('sent');
      expect(found?.provider_message_id).toBe('wa-id-final');
    });
  });

  it('markUnknown CAS: REFUSES to degrade a `sent` row', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-id-final',
        sent_at: new Date(),
      });
      await outboundMessagesRepo.markUnknown({
        idempotency_key: KEY,
        error: 'stale_unknown',
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('sent');
    });
  });

  it('markFailed CAS: REFUSES to degrade an `unknown` row', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markUnknown({
        idempotency_key: KEY,
        error: 'ambiguous',
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: KEY,
        error: 'stale_failed',
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('unknown');
    });
  });

  it('findByConversaTurn returns the LATEST attempt by created_at', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'first-attempt',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: 'first-attempt',
        error: 'first_attempt_failed',
      });
      await new Promise((r) => setTimeout(r, 5));
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'second-attempt',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'second-attempt',
        provider_message_id: 'wa-second',
        sent_at: new Date(),
      });
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('sent');
      expect(found?.provider_message_id).toBe('wa-second');
    });
  });

  it('findByConversaTurn returns null when no attempt exists', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found).toBeNull();
    });
  });

  it('CONCURRENT claims: Promise.all of two upsertPending → exactly one inserted', async () => {
    // Real-DB ON CONFLICT semantics: two same-key writers, only one
    // wins the INSERT. Our fake executes each call SEQUENTIALLY (no
    // real concurrency), but the SAME serialisation is what real
    // Postgres guarantees — the loser observes the existing pending
    // row and gets `inserted=false`.
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const results = await Promise.all([
        outboundMessagesRepo.upsertPending({
          idempotency_key: KEY,
          conversa_id: CONV,
          in_reply_to: TURN,
        }),
        outboundMessagesRepo.upsertPending({
          idempotency_key: KEY,
          conversa_id: CONV,
          in_reply_to: TURN,
        }),
      ]);
      const winners = results.filter((r) => r.inserted);
      expect(winners.length).toBe(1);
      // The loser sees the existing pending row but doesn't get to send.
      const losers = results.filter((r) => !r.inserted);
      expect(losers.length).toBe(1);
      expect(losers[0]!.skip).toBe(false);
      expect(losers[0]!.row.status).toBe('pending');
    });
  });

  it('markSent failure recovery via stale-pending: 31s later the row is reclaimable', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const start = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(start);
      // 1st turn: claim succeeds, but markSent never runs (simulated
      // crash mid-send).
      const claim1 = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(claim1.inserted).toBe(true);

      // Immediate retry: pending is too fresh, the conflict UPDATE is
      // filtered out → `inserted:false, status:pending`.
      const retryFresh = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retryFresh.inserted).toBe(false);

      // Advance 31s. The prior pending is now stale.
      vi.setSystemTime(start + 31_000);
      const retryStale = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      // The reclaim overwrites in-place — `inserted:false` but
      // `status:pending` (reset). The caller can proceed with the send.
      expect(retryStale.row.status).toBe('pending');
      vi.useRealTimers();
    });
  });
});

describe('outboundMessagesRepo — tenant context enforcement', () => {
  it('upsertPending without tenant context throws MissingTenantContextError', async () => {
    await expect(
      outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('markSent without tenant context throws MissingTenantContextError', async () => {
    await expect(
      outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-x',
        sent_at: new Date(),
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('markFailed without tenant context throws MissingTenantContextError', async () => {
    await expect(
      outboundMessagesRepo.markFailed({ idempotency_key: KEY, error: 'x' }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('markUnknown without tenant context throws MissingTenantContextError', async () => {
    await expect(
      outboundMessagesRepo.markUnknown({ idempotency_key: KEY, error: 'x' }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('findByConversaTurn without tenant context throws MissingTenantContextError', async () => {
    await expect(
      outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});

describe('outboundMessagesRepo — cross-tenant + cross-agent isolation (inviolable)', () => {
  it('tenant-A row is INVISIBLE from tenant-B context (A-first)', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'cross-key',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'cross-key',
        provider_message_id: 'wa-a',
        sent_at: new Date(),
      });
    });

    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found).toBeNull();
    });
  });

  it('tenant-A row is INVISIBLE from tenant-B context (B-first adversarial)', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'b-first-key',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'b-first-key',
        provider_message_id: 'wa-b',
        sent_at: new Date(),
      });
    });
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found).toBeNull();
    });
  });

  it('tenant-B cannot UPDATE a tenant-A row even with the same idempotency_key', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'shared-key',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
    });

    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      await outboundMessagesRepo.markSent({
        idempotency_key: 'shared-key',
        provider_message_id: 'wa-attacker',
        sent_at: new Date(),
      });
    });

    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.status).toBe('pending');
      expect(found?.provider_message_id).toBeNull();
    });
  });

  it('both tenants can hold INDEPENDENT rows for the same (conversa, turn) pair', async () => {
    // Composite UNIQUE allows cross-tenant key reuse — different
    // (tenant_id, agent_id, idempotency_key) tuples.
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'parallel-key',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'parallel-key',
        provider_message_id: 'wa-tenant-a',
        sent_at: new Date(),
      });
    });
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      // Same key under different tenant — composite unique allows it.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'parallel-key',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'parallel-key',
        provider_message_id: 'wa-tenant-b',
        sent_at: new Date(),
      });
    });

    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.provider_message_id).toBe('wa-tenant-a');
      expect(found?.tenant_id).toBe('tenant-a');
    });
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found?.provider_message_id).toBe('wa-tenant-b');
      expect(found?.tenant_id).toBe('tenant-b');
    });
  });

  it('AGENT scope: tenant-A/agent-X row is invisible from tenant-A/agent-Y', async () => {
    // Same tenant, different agents → composite unique allows separate
    // rows, and findByConversaTurn filters by agent_id too.
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-x' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'same-key-cross-agent',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'same-key-cross-agent',
        provider_message_id: 'wa-agent-x',
        sent_at: new Date(),
      });
    });
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-y' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found).toBeNull();
    });
  });
});
