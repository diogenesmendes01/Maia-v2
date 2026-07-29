/**
 * Issue #514 review round 2 [P1] — attempts of one turn must be legible AS one
 * turn, end to end.
 *
 * Round 1 gave every attempt its own `trace_id` so a retry could not collide on
 * the primary key. That fixed the crash and created fragmentation: the Explorer
 * listed N unrelated traces for one turn, and a retry investigation had no
 * thread to pull. The relation lived only in the correlation ALS.
 *
 * This spec walks the whole chain with the real implementations:
 *   traceTurnDecision → writeEnvelope (real row) → repo projection →
 *   tracesRouter.getTrace / listTraces
 * and asserts the grouping survives every hop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';

const { txRows, persisted, dbTransactionMock, dbInsertValuesMock, dbExecuteMock } = vi.hoisted(
  () => {
    const txRows: Array<{ table: string; row: Record<string, unknown> }> = [];
    const persisted = new Map<string, Record<string, unknown>>();

    function tableName(table: unknown): string {
      if (!table || typeof table !== 'object') return 'unknown';
      for (const sym of Object.getOwnPropertySymbols(table)) {
        if (String(sym) === 'Symbol(drizzle:Name)') {
          const v = (table as Record<symbol, unknown>)[sym];
          if (typeof v === 'string') return v;
        }
      }
      return 'unknown';
    }

    function insertInto(table: string, row: Record<string, unknown>) {
      const key = `${table}:${String(row.trace_id)}`;
      const conflict = persisted.has(key);
      const commit = (): void => {
        persisted.set(key, row);
        txRows.push({ table, row });
      };
      return {
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (conflict) return reject(new Error('duplicate key (23505)'));
          commit();
          return resolve(undefined);
        },
        onConflictDoNothing: () => {
          if (!conflict) commit();
          // Empty RETURNING on conflict — how the writer detects a replay.
          const rows = conflict ? [] : [{ trace_id: row.trace_id }];
          return {
            then: (res: (v: unknown) => void) => res(rows),
            returning: () => Promise.resolve(rows),
          };
        },
      };
    }

    return {
      txRows,
      persisted,
      dbInsertValuesMock: vi.fn().mockResolvedValue(undefined),
      dbExecuteMock: vi.fn().mockResolvedValue({ rows: [] }),
      dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: vi.fn((table: unknown) => ({
            values: vi.fn((row: Record<string, unknown>) => insertInto(tableName(table), row)),
          })),
          select: vi.fn(() => ({
            from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
          })),
        };
        await fn(tx);
      }),
    };
  },
);

vi.mock('@/db/client.js', () => ({
  db: {
    insert: () => ({ values: dbInsertValuesMock }),
    execute: dbExecuteMock,
    transaction: dbTransactionMock,
  },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    FEATURE_RUNTIME_TRACE_V1: true,
    MAIA_STRICT_METRIC_LABELS: false,
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'attempt-grouping-spec-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_DEBUG_AES_KEY: Buffer.alloc(32, 3).toString('base64'),
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
    RUNTIME_TRACE_BODY_ORPHAN_SEC: 300,
  },
}));

const { traceTurnDecision, envelopeTraceIdForAttempt } = await import(
  '@/observability/turn-trace.js'
);
const { runWithCorrelation, deriveTraceId } = await import('@/observability/correlation.js');
const { tracesRouter } = await import('@/admin-ui/trpc/routers/traces.js');

import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';

const TURN = 'turn-grouping-1';
const ROOT = deriveTraceId(TURN);
const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function baseFixture(): BaseContextPacket {
  return {
    trace_id: ROOT,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    session_id: CONVERSA_ID,
    conversation_id: CONVERSA_ID,
    channel: { id: 'ch-1', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p1', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: TURNO_ID,
      content_hmac: 'abc',
      received_at: '2026-07-01T10:00:00.000Z',
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    active_sensitive_memory_count: 0,
  } as BaseContextPacket;
}

function packetFixture(): DecisionPacket {
  return {
    trace_id: ROOT,
    intent: { label: 'x', confidence: 0.5 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: { agent_id: 'agent-a', candidate_skill_ids: [] },
    action_mode: 'call_tool',
    tool_permissions: { allowed_tools: [], blocked_tools: [], requires_confirmation: [] },
    context_requirements: {} as DecisionPacket['context_requirements'],
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: false },
    policy_decisions: [],
    rationale: '',
  } as DecisionPacket;
}

/** Drive attempt N of the turn exactly as the worker would. */
async function attemptTurn(attempt: number) {
  return runWithCorrelation({ seed: TURN, turn_id: TURN, attempt, origin: 'recovery' }, () =>
    traceTurnDecision({ base: baseFixture(), packet: packetFixture() }),
  );
}

function envelopeRows() {
  return txRows
    .filter((r) => r.table === 'runtime_trace_envelopes')
    .map((r) => r.row);
}

/** Router ctx backed by the rows the real writer produced. */
function makeCtx() {
  const rows = envelopeRows();
  return {
    session: { user: { id: 'u1', role: 'owner', tenant_id: 'tenant-A' } },
    userId: 'u1',
    userRole: 'owner',
    tenantId: 'tenant-A',
    repos: {
      runtimeTraceRepo: {
        async list() {
          return {
            items: rows.map((r) => ({ ...r, created_at: new Date() })),
            hasMore: false,
            nextCursor: null,
          };
        },
        async get({ traceId }: { traceId: string }) {
          const r = rows.find((x) => x.trace_id === traceId);
          if (!r) return null;
          return {
            ...r,
            created_at: new Date(),
            body_persisted_at: null,
            integrity: 'verified' as const,
            redacted_packet: {},
            redaction_applied: 'standard_v1',
            bytes_redacted: 0,
            encrypted: false,
            body_available: true,
          };
        },
        async listAttempts({ rootTraceId }: { rootTraceId: string }) {
          return rows
            .filter((r) => r.root_trace_id === rootTraceId)
            .sort((a, b) => Number(a.attempt) - Number(b.attempt))
            .map((r) => ({ ...r, created_at: new Date() }));
        },
      },
      debugSnapshotGrantsRepo: { async findActive() { return null; } },
      adminAuditLogRepo: { async append(r: unknown) { return r; } },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: () => {
      throw new TRPCError({ code: 'FORBIDDEN' });
    },
  };
}

describe('issue #514 [P1] — attempt grouping, writer → repo → Explorer', () => {
  beforeEach(async () => {
    txRows.length = 0;
    persisted.clear();
    dbTransactionMock.mockClear();
    await attemptTurn(1);
    await attemptTurn(2);
    await attemptTurn(3);
  });
  afterEach(() => {
    txRows.length = 0;
    persisted.clear();
  });

  describe('persistence', () => {
    it('every attempt persists the SAME root_trace_id', () => {
      const rows = envelopeRows();
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.root_trace_id))).toEqual(new Set([ROOT]));
    });

    it('attempt ordinals are persisted 1..N', () => {
      expect(envelopeRows().map((r) => r.attempt)).toEqual([1, 2, 3]);
    });

    it('attempt 1 keeps the root id; retries get their derived ids', () => {
      const rows = envelopeRows();
      expect(rows[0]!.trace_id).toBe(ROOT);
      expect(rows[1]!.trace_id).toBe(envelopeTraceIdForAttempt(ROOT, 2));
      expect(rows[2]!.trace_id).toBe(envelopeTraceIdForAttempt(ROOT, 3));
      expect(new Set(rows.map((r) => r.trace_id)).size).toBe(3);
    });

    it('grouping columns are NOT part of the signed payload', () => {
      // They are denormalised navigation, not decision evidence. `turno_id` —
      // which IS signed — remains the authoritative turn identity, so a
      // tampered `attempt` cannot merge two different turns.
      const rows = envelopeRows();
      expect(new Set(rows.map((r) => r.turno_id))).toEqual(new Set([TURNO_ID]));
      // Same decision content on every attempt ⇒ same signature INPUT except
      // trace_id, so the HMACs differ only because trace_id differs.
      expect(new Set(rows.map((r) => r.envelope_hmac)).size).toBe(3);
    });
  });

  describe('Explorer', () => {
    it('getTrace returns every sibling attempt, oldest first', async () => {
      const res = await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: ROOT });
      expect(res.attempt_count).toBe(3);
      expect(res.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
      expect(res.root_trace_id).toBe(ROOT);
    });

    it('marks which attempt is being viewed', async () => {
      const second = envelopeTraceIdForAttempt(ROOT, 2);
      const res = await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: second });
      expect(res.attempt).toBe(2);
      expect(res.attempts.filter((a) => a.is_current).map((a) => a.trace_id)).toEqual([second]);
    });

    it('opening ANY attempt reaches the same group — no dead ends', async () => {
      for (const id of envelopeRows().map((r) => r.trace_id as string)) {
        const res = await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: id });
        expect(res.attempt_count).toBe(3);
        expect(res.attempts.map((a) => a.trace_id)).toEqual(
          envelopeRows().map((r) => r.trace_id),
        );
      }
    });

    it('listTraces flags retries so the list does not read as N incidents', async () => {
      const res = await tracesRouter.createCaller(makeCtx()).listTraces({ limit: 50 });
      expect(res.items.map((i) => i.is_retry)).toEqual([false, true, true]);
      expect(res.items.map((i) => i.attempt)).toEqual([1, 2, 3]);
      expect(new Set(res.items.map((i) => i.root_trace_id))).toEqual(new Set([ROOT]));
    });

    it('a single-attempt turn reports a group of one (no retry noise)', async () => {
      txRows.length = 0;
      persisted.clear();
      await attemptTurn(1);
      const res = await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: ROOT });
      expect(res.attempt_count).toBe(1);
      expect(res.attempts[0]!.is_current).toBe(true);
      const list = await tracesRouter.createCaller(makeCtx()).listTraces({ limit: 50 });
      expect(list.items[0]!.is_retry).toBe(false);
    });
  });
});
