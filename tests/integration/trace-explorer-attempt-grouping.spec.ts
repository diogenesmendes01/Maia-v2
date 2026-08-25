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

/**
 * Issue #535: the Explorer's attempt grouping now goes through the REAL
 * `runtimeTraceRepo.listAttempts`, which verifies each sibling's signature. So
 * this spec needs a `db.select` too. It deliberately returns EVERY candidate
 * row and lets the repository decide: a fake that pre-filtered by `turno_id`
 * would be the harness re-implementing the control under test.
 */
const selectRows: Record<string, unknown>[] = [];

vi.mock('@/db/client.js', () => ({
  db: {
    insert: () => ({ values: dbInsertValuesMock }),
    execute: dbExecuteMock,
    transaction: dbTransactionMock,
    select: () => {
      const self = {
        from: () => self,
        where: () => self,
        orderBy: () => self,
        limit: () => Promise.resolve(selectRows),
        then: (resolve: (v: unknown) => void) => resolve(selectRows),
      };
      return self;
    },
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
vi.mock('@/config/contract-env.js', () => ({
  contractEnv: {
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
const { verifyEnvelopeIntegrity } = await import(
  '@/control-plane/runtime-trace/verify-envelope.js'
);
const { tracesRouter } = await import('@/admin-ui/trpc/routers/traces.js');
const { runtimeTraceRepo } = await import('@/db/repositories/runtime-trace-repos.js');

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

/** Every admin audit row the router wrote during a test. */
const auditRows: Array<Record<string, unknown>> = [];

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
        /**
         * Issue #535 — the REAL repository, not a stand-in. It is what enforces
         * the signed `turno_id` and drops a sibling whose own HMAC does not
         * hold; re-implementing either here would make this spec pass with the
         * production control deleted.
         */
        listAttempts: (args: { tenantId: string; rootTraceId: string; turnoId: string }) => {
          selectRows.length = 0;
          selectRows.push(
            ...rows
              .filter((r) => r.root_trace_id === args.rootTraceId)
              .sort((a, b) => Number(a.attempt) - Number(b.attempt))
              .map((r) => ({ ...r, created_at: new Date(), body_persisted_at: null })),
          );
          return runtimeTraceRepo.listAttempts(args);
        },
      },
      debugSnapshotGrantsRepo: { async findActive() { return null; } },
      adminAuditLogRepo: {
        async append(r: Record<string, unknown>) {
          auditRows.push(r);
          return r;
        },
      },
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
    auditRows.length = 0;
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

    it('issue #535 — every attempt is written with signature_version=2, never v1', () => {
      // The write path has ONE version and it is a constant. If production ever
      // emits v1 again, this is the row-level tripwire.
      expect(envelopeRows().map((r) => r.signature_version)).toEqual([2, 2, 2]);
    });

    it('issue #535 — the grouping columns are now INSIDE the signature', () => {
      const rows = envelopeRows();
      expect(new Set(rows.map((r) => r.turno_id))).toEqual(new Set([TURNO_ID]));
      expect(new Set(rows.map((r) => r.envelope_hmac)).size).toBe(3);
      // Re-verifying the row as written must hold; flipping `root_trace_id` or
      // `attempt` must not. Before #535 both of those flips verified fine —
      // that is exactly the gap the owner asked to close.
      for (const r of rows) {
        const asWritten = {
          ...r,
          envelope_hmac: r.envelope_hmac as string,
        } as never;
        expect(verifyEnvelopeIntegrity(asWritten)).toBe('verified');
        expect(
          verifyEnvelopeIntegrity({
            ...(r as Record<string, unknown>),
            root_trace_id: '44444444-4444-4444-8444-444444444444',
          } as never),
        ).toBe('invalid');
        expect(
          verifyEnvelopeIntegrity({
            ...(r as Record<string, unknown>),
            attempt: 99,
          } as never),
        ).toBe('invalid');
      }
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

    it('issue #535 — the Explorer passes the SIGNED turno_id into the grouping', async () => {
      // Anchored on the real repo: it throws when the turno_id is absent, so a
      // router that stopped passing it would fail here rather than quietly go
      // back to grouping on `root_trace_id` alone.
      const seen: Array<Record<string, unknown>> = [];
      const ctx = makeCtx();
      const inner = ctx.repos.runtimeTraceRepo.listAttempts as (a: never) => unknown;
      (ctx.repos.runtimeTraceRepo as unknown as Record<string, unknown>).listAttempts = (
        args: Record<string, unknown>,
      ) => {
        seen.push(args);
        return inner(args as never);
      };
      const res = await tracesRouter.createCaller(ctx).getTrace({ traceId: ROOT });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.turnoId).toBe(TURNO_ID);
      expect(res.attempt_grouping_signed).toBe(true);
    });

    it('issue #535 — a foreign turn spliced in by rewriting root_trace_id is refused', async () => {
      // The "fusão visual entre turnos" the owner named. The forged row is a
      // genuine envelope of ANOTHER turn whose `root_trace_id` was edited to
      // point at this one. Its `turno_id` is signed, so the moment the SQL
      // predicate is satisfied by also rewriting it, the signature breaks.
      const genuineOther = { ...envelopeRows()[0]! };
      const forged = {
        ...genuineOther,
        trace_id: '00000000-0000-4000-8000-0000000000ff',
        attempt: 4,
        root_trace_id: ROOT,
        // Rewritten to satisfy the new predicate — and detected by the HMAC.
        turno_id: TURNO_ID,
        envelope_hmac: 'assinatura-forjada-neste-teste',
      };
      txRows.push({ table: 'runtime_trace_envelopes', row: forged });
      const res = await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: ROOT });
      expect(res.attempts.map((a) => a.trace_id)).not.toContain(forged.trace_id);
      expect(res.attempt_count).toBe(3);

      // The refusal is AUDITED, not merely logged: a detection nobody can read
      // back later is not a detection.
      const audited = auditRows.filter(
        (r) => r.action === 'runtime_trace_attempt_group_row_refused',
      );
      expect(audited).toHaveLength(1);
      const summary = audited[0]!.change_summary as {
        refused: Array<{ trace_id: string; integrity: string }>;
      };
      expect(summary.refused.map((r) => r.trace_id)).toEqual([forged.trace_id]);
      expect(summary.refused[0]!.integrity).toBe('invalid');
    });

    it('a clean group audits nothing — the audit is the exception, not the trace', async () => {
      await tracesRouter.createCaller(makeCtx()).getTrace({ traceId: ROOT });
      expect(
        auditRows.filter((r) => r.action === 'runtime_trace_attempt_group_row_refused'),
      ).toHaveLength(0);
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
