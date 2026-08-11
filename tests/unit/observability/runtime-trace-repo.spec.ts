/**
 * Issue #514 §7 — runtimeTraceRepo: tenant scoping, keyset cursor, no OFFSET.
 *
 * The Drizzle query builder is captured through a recording fake so the spec
 * can assert on the SHAPE of the query (order, limit, absence of offset)
 * without a Postgres connection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const captured: {
  where: unknown[];
  orderBy: unknown[];
  limit: number | null;
  offsetCalled: boolean;
  rows: unknown[];
} = { where: [], orderBy: [], limit: null, offsetCalled: false, rows: [] };

function chain() {
  const self = {
    from: () => self,
    where: (w: unknown) => {
      captured.where.push(w);
      return self;
    },
    orderBy: (...o: unknown[]) => {
      captured.orderBy.push(...o);
      return self;
    },
    groupBy: () => Promise.resolve(captured.rows),
    offset: () => {
      captured.offsetCalled = true;
      return self;
    },
    limit: (n: number) => {
      captured.limit = n;
      return Promise.resolve(captured.rows);
    },
    then: (resolve: (v: unknown) => void) => resolve(captured.rows),
  };
  return self;
}

vi.mock('@/db/client.js', () => ({
  db: { select: vi.fn(() => chain()) },
}));

const { runtimeTraceRepo, encodeTraceCursor, decodeTraceCursor, TraceTenantScopeError } =
  await import('@/db/repositories/runtime-trace-repos.js');

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';

function row(over: Record<string, unknown> = {}) {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    conversa_id: null,
    turno_id: null,
    decision: 'allow',
    side_effect_level: 'low',
    redaction_class: 'standard',
    body_status: 'persisted',
    body_persisted_at: null,
    created_at: new Date('2026-07-01T10:00:00Z'),
    ...over,
  };
}

describe('issue #514 — runtimeTraceRepo', () => {
  beforeEach(() => {
    captured.where = [];
    captured.orderBy = [];
    captured.limit = null;
    captured.offsetCalled = false;
    captured.rows = [];
  });

  describe('fail-closed tenant guard', () => {
    it.each([['', 'empty'], ['   ', 'whitespace']])('rejects %s tenant (%s)', async (tenantId) => {
      await expect(runtimeTraceRepo.list({ tenantId, limit: 10 })).rejects.toThrow(
        TraceTenantScopeError,
      );
    });

    it('rejects a missing tenant instead of listing everything', async () => {
      await expect(
        // @ts-expect-error — deliberately violating the contract
        runtimeTraceRepo.list({ limit: 10 }),
      ).rejects.toThrow(TraceTenantScopeError);
    });

    it('rejects the `default` literal (AGENTS.md §4.8)', async () => {
      const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
      delete process.env.MAIA_REJECT_DEFAULT_LITERAL; // default-ON
      await expect(runtimeTraceRepo.list({ tenantId: 'default', limit: 10 })).rejects.toThrow();
      if (prev !== undefined) process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    });

    it('guards `get` and `bodyStatusCounts` the same way', async () => {
      await expect(
        runtimeTraceRepo.get({ tenantId: '', traceId: TRACE_ID }),
      ).rejects.toThrow(TraceTenantScopeError);
      await expect(runtimeTraceRepo.bodyStatusCounts({ tenantId: '' })).rejects.toThrow(
        TraceTenantScopeError,
      );
    });
  });

  describe('list', () => {
    it('orders newest first with a tiebreaker and never uses OFFSET', async () => {
      captured.rows = [row()];
      await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 50 });
      // Two order keys: created_at DESC, trace_id DESC — the composite that
      // makes the keyset cursor total.
      expect(captured.orderBy).toHaveLength(2);
      expect(captured.offsetCalled).toBe(false);
    });

    it('fetches limit + 1 to detect hasMore without a COUNT', async () => {
      captured.rows = [row(), row({ trace_id: 'b' })];
      const res = await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 1 });
      expect(captured.limit).toBe(2);
      expect(res.items).toHaveLength(1);
      expect(res.hasMore).toBe(true);
      expect(res.nextCursor).not.toBeNull();
    });

    it('reports no cursor on the last page', async () => {
      captured.rows = [row()];
      const res = await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 50 });
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it('clamps a hostile limit', async () => {
      captured.rows = [];
      await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 100000 });
      expect(captured.limit).toBe(201); // 200 + 1
      await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: -5 });
      expect(captured.limit).toBe(2); // 1 + 1
    });

    it('handles an empty page', async () => {
      captured.rows = [];
      const res = await runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 50 });
      expect(res).toEqual({ items: [], hasMore: false, nextCursor: null });
    });
  });

  describe('cursor', () => {
    it('round-trips', () => {
      const c = encodeTraceCursor({
        created_at: new Date('2026-07-01T10:00:00Z'),
        trace_id: TRACE_ID,
      });
      const back = decodeTraceCursor(c);
      expect(back!.id).toBe(TRACE_ID);
      expect(back!.ts.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    });

    it('is opaque (base64url, not a readable id)', () => {
      const c = encodeTraceCursor({ created_at: new Date(), trace_id: TRACE_ID });
      expect(c).not.toContain(TRACE_ID);
      expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it.each([
      [null, 'null'],
      [undefined, 'undefined'],
      ['', 'empty'],
      ['not-base64!!', 'garbage'],
      [Buffer.from('{"ts":123}').toString('base64url'), 'wrong types'],
      [Buffer.from('{"ts":"nope","id":"x"}').toString('base64url'), 'bad date'],
      [
        Buffer.from('{"ts":"2026-07-01T10:00:00Z","id":"not-a-uuid"}').toString('base64url'),
        'non-UUID id',
      ],
    ])('decodes %s (%s) to null instead of throwing', (cursor) => {
      expect(decodeTraceCursor(cursor as string | null | undefined)).toBeNull();
    });

    it('a hostile cursor degrades to the first page, not an error', async () => {
      captured.rows = [row()];
      await expect(
        runtimeTraceRepo.list({ tenantId: 'tenant-A', limit: 10, cursor: "'; DROP TABLE--" }),
      ).resolves.toBeDefined();
    });
  });

  describe('get', () => {
    it('returns null when the trace is not in this tenant', async () => {
      captured.rows = [];
      expect(
        await runtimeTraceRepo.get({ tenantId: 'tenant-A', traceId: TRACE_ID }),
      ).toBeNull();
    });

    it('never hands out an encrypted body', async () => {
      // Both the envelope and body selects read the same fake rows; the second
      // read supplies the body fields.
      captured.rows = [
        {
          ...row(),
          policy_id: null,
          envelope_hmac: 'sig',
          hmac_key_version: 1,
          packet: { secret: 'ciphertext' },
          encrypted: true,
          redaction_applied: 'debug_encrypted_v1',
          bytes_redacted: 0,
        },
      ];
      const res = await runtimeTraceRepo.get({ tenantId: 'tenant-A', traceId: TRACE_ID });
      expect(res!.encrypted).toBe(true);
      expect(res!.redacted_packet).toBeNull();
      expect(res!.body_available).toBe(true);
    });
  });

  describe('bodyStatusCounts', () => {
    it('always reports all three states, defaulting to 0', async () => {
      captured.rows = [{ body_status: 'pending', n: 4 }];
      const counts = await runtimeTraceRepo.bodyStatusCounts({ tenantId: 'tenant-A' });
      expect(counts).toEqual({ pending: 4, persisted: 0, orphaned: 0 });
    });
  });
});
