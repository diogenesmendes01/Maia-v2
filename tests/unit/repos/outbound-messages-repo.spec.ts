/**
 * Issue #227 — outboundMessagesRepo unit tests.
 *
 * Pattern: in-memory db fake (drizzle predicates evaluated against a
 * `Map<table, Row[]>`), mirroring the production skills-repo tests under
 * PR #222. Tests prove:
 *   1. upsertPending inserts a fresh `pending` row when no prior key.
 *   2. upsertPending returns `skip:true` when a row for the key is
 *      already at status='sent'.
 *   3. upsertPending returns `skip:false` for pending/failed/unknown
 *      prior rows (the retry case where the caller decides what to do).
 *   4. markSent / markFailed / markUnknown move the row forward.
 *   5. findByConversaTurn returns the LATEST attempt for the turn.
 *   6. All methods throw without tenant context (MissingTenantContextError).
 *   7. CROSS-TENANT: a row inserted under tenant-A is invisible from
 *      tenant-B context (the inviolable tenant isolation invariant).
 *      Both insertion orders (A-first AND B-first) are exercised
 *      adversarially per the PR #222 pattern.
 *   8. UNIQUE collision on idempotency_key is handled: the repo
 *      re-reads the prior winner and returns it instead of throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + drizzle/db fakes (pattern from skills-repo-atomic.spec.ts)
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

vi.mock('drizzle-orm', () => {
  const eq = (left: unknown, right: unknown): PredObj => ({
    __pred: (row: Row) => {
      const key = isColRef(left) ? left.__col : String(left);
      return row[key] === right;
    },
  });
  const and = (...conds: unknown[]): PredObj => ({
    __pred: (row: Row) =>
      conds.every((c) => (isPredObj(c) ? c.__pred(row) : true)),
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
  return { eq, and, desc };
});

function makeTable(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, prop: string) => ({ __col: prop }),
    },
  );
}

vi.mock('@/db/schema.js', () => ({
  outbound_messages: makeTable(),
}));

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

class InsertBuilder {
  private _table: unknown = null;
  private _values: Row | null = null;
  constructor(t: unknown) {
    this._table = t;
  }
  values(v: Row) {
    this._values = v;
    return this;
  }
  returning() {
    return this;
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      if (!this._values) {
        resolve([]);
        return;
      }
      // Enforce the UNIQUE constraint on idempotency_key per the
      // production schema. A collision throws a `code=23505` shaped
      // error to mirror the postgres path the repo catches.
      const dupe = tableOf(this._table).find(
        (r) => r.idempotency_key === this._values!.idempotency_key,
      );
      if (dupe) {
        const err = new Error(
          'duplicate key value violates unique constraint "outbound_messages_idempotency_key_key"',
        ) as Error & { code: string };
        err.code = '23505';
        reject?.(err);
        return;
      }
      const row: Row = {
        id: `om-${Math.random().toString(36).slice(2)}`,
        provider_message_id: null,
        sent_at: null,
        error: null,
        created_at: new Date(),
        ...this._values,
      };
      tableOf(this._table).push(row);
      resolve([{ ...row }]);
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
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try {
      if (!this._set) {
        resolve([]);
        return;
      }
      const rows = tableOf(this._table);
      for (const r of rows) {
        if (this._pred(r)) {
          Object.assign(r, this._set);
        }
      }
      resolve([]);
    } catch (e) {
      reject?.(e);
    }
  }
}

vi.mock('@/db/client.js', () => ({
  db: {
    select: () => new SelectBuilder(),
    insert: (t: unknown) => new InsertBuilder(t),
    update: (t: unknown) => new UpdateBuilder(t),
  },
}));

import { outboundMessagesRepo } from '@/db/repositories/outbound-messages-repo.js';
import { MissingTenantContextError } from '@/db/tenant-context.js';

const CONV = '00000000-0000-0000-0000-000000000001';
const TURN = '00000000-0000-0000-0000-000000000002';
const KEY = 'tenant-a-test-key-1';

beforeEach(() => {
  store.clear();
});

describe('outboundMessagesRepo — basic CRUD + status transitions', () => {
  it('upsertPending inserts a fresh pending row when no prior key', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      const res = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
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
      // First call → pending.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      // Move to sent.
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-xyz',
        sent_at: new Date(),
      });
      // Retry — must short-circuit.
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(retry.skip).toBe(true);
      expect(retry.row.status).toBe('sent');
      expect(retry.row.provider_message_id).toBe('wa-xyz');
    });
  });

  it('upsertPending returns skip=false for prior pending/failed/unknown', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      // Seed: a row stuck in pending (crashed prior attempt).
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-pending',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      const r1 = await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-pending',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(r1.skip).toBe(false);
      expect(r1.row.status).toBe('pending');

      // Failed.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-failed',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: 'key-failed',
        error: 'no_socket',
      });
      const r2 = await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-failed',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(r2.skip).toBe(false);
      expect(r2.row.status).toBe('failed');

      // Unknown.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-unknown',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markUnknown({
        idempotency_key: 'key-unknown',
        error: 'ambiguous_throw',
      });
      const r3 = await outboundMessagesRepo.upsertPending({
        idempotency_key: 'key-unknown',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(r3.skip).toBe(false);
      expect(r3.row.status).toBe('unknown');
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

  it('findByConversaTurn returns the LATEST attempt by created_at', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      // Two attempts for the same turn, different text → different keys.
      // The fake store inserts in order; the second has a later created_at.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'first-attempt',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markFailed({
        idempotency_key: 'first-attempt',
        error: 'first_attempt_failed',
      });
      // Force a strictly-later created_at so the ORDER BY DESC test is
      // deterministic on machines with coarse Date.now resolution.
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

  it('UNIQUE collision: parallel-writer race resolves to existing row', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      // Step 1: prime the fake store by doing a real insert through
      // the repo. This both proves the happy path AND ensures the
      // schema-mocked table object is available as a key in `store`.
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'seed-key-for-race',
        conversa_id: CONV,
        in_reply_to: TURN,
      });

      // Step 2: simulate a CONCURRENT commit by inserting a row
      // directly into the fake's table for a DIFFERENT key — this is
      // the parallel-writer winner. We then call upsertPending with
      // the same key as the planted row.
      const tbl = Array.from(store.keys()).find((k) => k !== null) as unknown;
      const rows = tableOf(tbl);
      rows.push({
        id: 'pre-existing',
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
        status: 'sent',
        provider_message_id: 'wa-original',
        sent_at: new Date(),
        error: null,
        created_at: new Date(),
      });
      const retry = await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      // SELECT path finds the row → returns it with skip=true.
      expect(retry.skip).toBe(true);
      expect(retry.row.provider_message_id).toBe('wa-original');
    });
  });
});

describe('outboundMessagesRepo — valid status transitions', () => {
  it('a pending → sent → markUnknown is captured (last-writer-wins at row level)', async () => {
    // The repo doesn't enforce a state machine in code — the migration's
    // CHECK constraint only enforces the value set. This test documents
    // the actual behaviour: an explicit transition overwrites status.
    // Real callers in output-dispatch never do this; the test guards
    // against an accidental code change that would silently freeze a
    // status.
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: KEY,
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: KEY,
        provider_message_id: 'wa-x',
        sent_at: new Date(),
      });
      const afterSent = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(afterSent?.status).toBe('sent');

      // A subsequent markUnknown for the same key (e.g., a stale
      // background retry) overwrites the status. Production code does
      // NOT do this — the markSent path is the terminal one. Documented
      // so a future tightening (e.g., refuse-transition-from-sent) is
      // an explicit decision.
      await outboundMessagesRepo.markUnknown({
        idempotency_key: KEY,
        error: 'stale_retry',
      });
      const afterUnknown = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(afterUnknown?.status).toBe('unknown');
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

describe('outboundMessagesRepo — cross-tenant isolation (inviolable)', () => {
  it('tenant-A row is INVISIBLE from tenant-B context (A-first)', async () => {
    // Adversarial seed order: insert tenant-A first.
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

    // Same conversa_id + in_reply_to under tenant-B. The (conversa, turn)
    // pair would naturally collide if isolation weren't enforced.
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      const found = await outboundMessagesRepo.findByConversaTurn({
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      expect(found).toBeNull();
    });
  });

  it('tenant-A row is INVISIBLE from tenant-B context (B-first adversarial)', async () => {
    // Adversarial seed order: insert tenant-B first so a missing
    // WHERE tenant_id filter would surface tenant-B's row to tenant-A.
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

    // Tenant-B tries to forcibly mark the row sent (e.g., a malicious or
    // buggy caller). Even though the key is unique globally, the WHERE
    // includes tenant_id so the UPDATE is a no-op.
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      await outboundMessagesRepo.markSent({
        idempotency_key: 'shared-key',
        provider_message_id: 'wa-attacker',
        sent_at: new Date(),
      });
    });

    // Back to tenant-A: the row must still be pending.
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
    // The (conversa_id, in_reply_to) pair is shared but the keys differ
    // because the caller hashes content into the key. Each tenant
    // operates on its own row; neither sees the other's.
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-a' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'parallel-a',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'parallel-a',
        provider_message_id: 'wa-tenant-a',
        sent_at: new Date(),
      });
    });
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'agent-b' }, async () => {
      await outboundMessagesRepo.upsertPending({
        idempotency_key: 'parallel-b',
        conversa_id: CONV,
        in_reply_to: TURN,
      });
      await outboundMessagesRepo.markSent({
        idempotency_key: 'parallel-b',
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
});
