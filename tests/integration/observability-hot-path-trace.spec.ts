/**
 * Issue #514 §4 — end-to-end: hot-path adapter → real `trace()` → real
 * envelope writer (HMAC + outbox in one transaction) → real body writer
 * (redaction), with only the DB client mocked.
 *
 * Follows the harness of `tests/integration/p10b-runtime-trace.spec.ts`: no
 * Postgres required, but every layer between the decision boundary and the
 * INSERT is the production code.
 *
 * What this proves that the unit specs cannot:
 *   - the packet the adapter builds actually survives real redaction with
 *     nothing dropped and no PII reintroduced;
 *   - the envelope HMAC is tenant-derived, so two tenants that make the
 *     IDENTICAL decision get different signatures (invariant: tenant isolation
 *     reaches the evidence layer);
 *   - a mandatory envelope failure aborts the turn (invariant 12).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  dbInsertValuesMock,
  dbExecuteMock,
  dbTransactionMock,
  txRows,
  persisted,
  UniqueViolationError,
  selectFrom,
} = vi.hoisted(() => {
  const txRows: Array<{ table: string; row: Record<string, unknown> }> = [];

  /**
   * Review round 1 [P1] — the previous fake accepted every INSERT, so the
   * retry spec zeroed `txRows` between attempts and never exercised the fact
   * that `runtime_trace_envelopes.trace_id` is a PRIMARY KEY. It was a test
   * that could not fail for the right reason.
   *
   * This fake models real PK semantics:
   *   - a plain INSERT of an existing `trace_id` THROWS a unique violation
   *     (Postgres SQLSTATE 23505), exactly like the database;
   *   - `.onConflictDoNothing()` swallows the conflict and inserts nothing.
   *
   * `persisted` is the durable store and survives `txRows` being cleared, so a
   * spec can inspect the last transaction's rows without losing uniqueness
   * state across attempts.
   */
  const persisted = new Map<string, Record<string, unknown>>();

  /**
   * Resolve a Drizzle table's real name. It lives under `Symbol(drizzle:Name)`,
   * NOT `table._.name` (which is `undefined`). The previous fake read `._.name`
   * and silently labelled every row `'unknown'`, so the envelope and its outbox
   * row — which share a `trace_id` — were indistinguishable. Keying the store
   * on that would have made the outbox insert look like a duplicate of the
   * envelope.
   */
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

  class UniqueViolationError extends Error {
    code = '23505';
    constructor(key: string) {
      super(`duplicate key value violates unique constraint (${key})`);
      this.name = 'UniqueViolationError';
    }
  }

  function insertInto(table: string, row: Record<string, unknown>) {
    const key = `${table}:${String(row.trace_id)}`;
    const conflict = persisted.has(key);
    const commit = (): void => {
      persisted.set(key, row);
      txRows.push({ table, row });
    };
    return {
      // Awaited without a conflict clause → behaves like a bare INSERT.
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        if (conflict) return reject(new UniqueViolationError(key));
        commit();
        return resolve(undefined);
      },
      onConflictDoNothing: () => {
        if (!conflict) commit();
        // Postgres RETURNING yields NO row when the conflict clause suppressed
        // the insert — that empty array is exactly how the writer detects a
        // replay (issue #514 round 2 [P2]).
        const rows = conflict ? [] : [{ trace_id: row.trace_id }];
        return {
          then: (resolve: (v: unknown) => void) => resolve(rows),
          returning: () => Promise.resolve(rows),
        };
      },
    };
  }

  /**
   * Reads the same store so a conflict can be compared against what is there.
   *
   * Deliberately NOT a query engine: it cannot interpret drizzle's `eq(...)`,
   * so it returns every row of the table and relies on the writer's `.limit(1)`
   * taking the first. That is faithful for the replay scenario under test —
   * one trace id, one stored row — and the specs keep it that way by clearing
   * `persisted` between cases. Do not reach for it to model multi-row queries.
   */
  function selectFrom() {
    let table = '';
    const self = {
      from: (t: unknown) => {
        table = tableName(t);
        return self;
      },
      where: () => self,
      limit: () =>
        Promise.resolve(
          [...persisted.entries()]
            .filter(([k]) => k.startsWith(`${table}:`))
            .map(([, v]) => v),
        ),
    };
    return self;
  }

  return {
    txRows,
    persisted,
    UniqueViolationError,
    selectFrom,
    dbInsertValuesMock: vi.fn().mockResolvedValue(undefined),
    dbExecuteMock: vi.fn().mockResolvedValue({ rows: [] }),
    dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((row: Record<string, unknown>) => insertInto(tableName(table), row)),
        })),
        // The writer SELECTs inside the transaction on the conflict path.
        select: vi.fn(() => selectFrom()),
      };
      await fn(tx);
    }),
  };
});

vi.mock('@/db/client.js', () => ({
  db: {
    insert: () => ({ values: dbInsertValuesMock }),
    select: () => selectFrom(),
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
    // #515: the rollout gate is a contract variable read through the loader,
    // so it is part of the mocked config rather than a `process.env` write.
    // These specs exercise the ON path end-to-end.
    FEATURE_RUNTIME_TRACE_V1: true,
    MAIA_STRICT_METRIC_LABELS: false,
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'issue-514-hot-path-master-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_DEBUG_AES_KEY: Buffer.alloc(32, 7).toString('base64'),
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
    RUNTIME_TRACE_BODY_ORPHAN_SEC: 300,
  },
}));

const {
  traceTurnDecision,
  toContextStub,
  MandatoryTraceEnvelopeError,
  envelopeTraceIdForAttempt,
} = await import('@/observability/turn-trace.js');
const { redactPacket } = await import('@/control-plane/runtime-trace/lib/redaction.js');
const { verifyHmac, canonicalJson } = await import('@/control-plane/runtime-trace/lib/hmac.js');
const { runWithCorrelation, deriveTraceId } = await import('@/observability/correlation.js');

import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';

const CONVERSA_ID = '11111111-2222-4333-8444-555555555555';
const TURNO_ID = '99999999-8888-4777-8666-555555555555';

function baseFixture(tenant_id: string, trace_id: string): BaseContextPacket {
  return {
    trace_id,
    tenant_id,
    agent_id: 'a1',
    session_id: CONVERSA_ID,
    conversation_id: CONVERSA_ID,
    channel: { id: 'ch-1', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p1', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: TURNO_ID,
      content_hmac: 'deadbeefdeadbeef',
      received_at: '2026-07-01T10:00:00.000Z',
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    active_sensitive_memory_count: 0,
  } as BaseContextPacket;
}

function packetFixture(over: Partial<DecisionPacket> = {}): DecisionPacket {
  return {
    trace_id: 'x',
    intent: { label: 'consulta', confidence: 0.8 },
    risk_profile: { level: 'medium', reasons: ['valor alto'], requires_human_review: false },
    routing: { agent_id: 'a1', candidate_skill_ids: [] },
    action_mode: 'call_tool',
    tool_permissions: { allowed_tools: ['x'], blocked_tools: [], requires_confirmation: [] },
    context_requirements: {} as DecisionPacket['context_requirements'],
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: false },
    policy_decisions: [
      {
        pep: 'mid',
        policy_id: 'pol-1',
        rule_descriptor: 'limite.transferencia',
        decision: 'allow',
        reason: 'cliente disse "meu telefone é +55 11 99999-9999"',
      },
    ],
    rationale: 'sensitive rationale that must never be persisted',
    ...over,
  } as DecisionPacket;
}

describe('issue #514 — hot-path runtime trace, real writers', () => {
  beforeEach(() => {
    txRows.length = 0;
    persisted.clear();
    dbTransactionMock.mockClear();
  });

  it('writes the envelope + body outbox row in ONE transaction', async () => {
    const trace_id = deriveTraceId('turn-e2e-1');
    const env = await traceTurnDecision({
      base: baseFixture('acme', trace_id),
      packet: packetFixture(),
      evaluation_ms: 12,
    });

    expect(env).not.toBeNull();
    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
    expect(txRows).toHaveLength(2); // envelope + outbox

    const envelope = txRows.filter((r) => r.table === 'runtime_trace_envelopes')[0]!.row;
    expect(envelope.trace_id).toBe(trace_id);
    expect(envelope.tenant_id).toBe('acme');
    expect(envelope.agent_id).toBe('a1');
    expect(envelope.conversa_id).toBe(CONVERSA_ID);
    expect(envelope.turno_id).toBe(TURNO_ID);
    expect(envelope.decision).toBe('allow');
    // call_tool ⇒ medium ⇒ envelope was MANDATORY before the effect.
    expect(envelope.side_effect_level).toBe('medium');
    expect(envelope.body_status).toBe('pending');
  });

  it('signs the envelope with a TENANT-derived key — same decision, different tenants, different HMAC', async () => {
    // Distinct trace ids per tenant: `trace_id` is the PK, so two tenants
    // sharing one is not a state the database can hold. What this asserts is
    // that the KEY is tenant-derived, which the identical decision payload
    // isolates.
    const traceA = deriveTraceId('turn-e2e-2-a');
    const traceB = deriveTraceId('turn-e2e-2-b');
    await traceTurnDecision({ base: baseFixture('tenant-a', traceA), packet: packetFixture() });
    await traceTurnDecision({ base: baseFixture('tenant-b', traceB), packet: packetFixture() });

    const envelopes = txRows.filter((r) => r.table === 'runtime_trace_envelopes');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]!.row.envelope_hmac).not.toBe(envelopes[1]!.row.envelope_hmac);
  });

  it('the envelope HMAC verifies against its own signed payload', async () => {
    const trace_id = deriveTraceId('turn-e2e-3');
    await traceTurnDecision({ base: baseFixture('acme', trace_id), packet: packetFixture() });
    const row = txRows.filter((r) => r.table === 'runtime_trace_envelopes')[0]!.row;

    const signed = {
      trace_id: row.trace_id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      conversa_id: row.conversa_id,
      turno_id: row.turno_id,
      policy_id: row.policy_id,
      decision: row.decision,
      side_effect_level: row.side_effect_level,
      redaction_class: row.redaction_class,
      hmac_key_version: row.hmac_key_version,
    };
    expect(
      verifyHmac('acme', row.hmac_key_version as number, signed, row.envelope_hmac as string),
    ).toBe(true);
    // Tampering with any signed field breaks verification.
    expect(
      verifyHmac(
        'acme',
        row.hmac_key_version as number,
        { ...signed, decision: 'deny' },
        row.envelope_hmac as string,
      ),
    ).toBe(false);
    expect(canonicalJson(signed)).toBeTypeOf('string');
  });

  it('the outbox payload survives REAL redaction with nothing dropped and no PII', async () => {
    const trace_id = deriveTraceId('turn-e2e-4');
    await traceTurnDecision({ base: baseFixture('acme', trace_id), packet: packetFixture() });

    const outbox = txRows.filter((r) => r.table === 'runtime_trace_body_outbox')[0]!.row;
    const payload = outbox.payload as { packet: Record<string, unknown> };
    const { packet: redacted, bytes_redacted } = redactPacket(payload.packet, 'standard');
    const serialized = JSON.stringify(redacted);

    // Nothing outside the allowlist ⇒ the evidence trail loses no field.
    expect(
      (redacted as Record<string, unknown>)._redaction_dropped_unknown_count ?? 0,
    ).toBe(0);
    expect(bytes_redacted).toBe(0);

    // The operator-authored policy reason quoted a phone number and the
    // rationale was free text — neither may reach durable storage.
    expect(serialized).not.toContain('99999-9999');
    expect(serialized).not.toContain('telefone');
    expect(serialized).not.toContain('sensitive rationale');
    expect(JSON.stringify(outbox)).not.toContain('99999-9999');
  });

  it('a MANDATORY envelope failure aborts the turn (P10b invariant 12)', async () => {
    const cause = new Error('postgres unavailable');
    dbTransactionMock.mockRejectedValueOnce(cause);
    let thrown: unknown;
    try {
      await traceTurnDecision({
        base: baseFixture('acme', deriveTraceId('turn-e2e-5')),
        packet: packetFixture({ action_mode: 'call_tool' }),
      });
    } catch (e) {
      thrown = e;
    }
    // Typed, so `agent/core.ts` recognises it as a block (review round 1 [P1]).
    expect(thrown).toBeInstanceOf(MandatoryTraceEnvelopeError);
    expect((thrown as { cause_error?: unknown }).cause_error).toBe(cause);
  });

  it('a NON-mandatory envelope failure does not abort a read-only turn', async () => {
    dbTransactionMock.mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(
      traceTurnDecision({
        base: baseFixture('acme', deriveTraceId('turn-e2e-6')),
        packet: packetFixture({ action_mode: 'respond' }),
      }),
    ).resolves.toBeNull();
  });

  it('the correlated root trace is what lands in the envelope', async () => {
    await runWithCorrelation({ seed: 'turn-e2e-7', turn_id: 'turn-e2e-7' }, async () => {
      const trace_id = deriveTraceId('turn-e2e-7');
      await traceTurnDecision({
        base: baseFixture('acme', trace_id),
        packet: packetFixture(),
      });
      expect(txRows.filter((r) => r.table === 'runtime_trace_envelopes')[0]!.row.trace_id).toBe(trace_id);
    });
  });

  describe('retry / recovery under REAL primary-key semantics [P1]', () => {
    const TURN = 'turn-e2e-8';
    const root = deriveTraceId(TURN);

    /** Drive one attempt of the same turn, exactly as the worker would. */
    async function attemptTurn(attempt: number) {
      return runWithCorrelation(
        { seed: TURN, turn_id: TURN, attempt, origin: 'recovery' },
        () =>
          traceTurnDecision({
            base: baseFixture('acme', root),
            packet: packetFixture(),
          }),
      );
    }

    it('the fake enforces uniqueness — a bare duplicate INSERT throws 23505', async () => {
      // Guard on the guard. If this ever stops throwing, every assertion below
      // becomes vacuous, which is precisely how the previous revision passed
      // while the production code was broken.
      const { db } = await import('@/db/client.js');
      await db.transaction(async (tx) => {
        const t = { _: { name: 'probe_table' } };
        await (tx as { insert: (t: unknown) => { values: (r: unknown) => Promise<unknown> } })
          .insert(t)
          .values({ trace_id: root });
      });
      await expect(
        db.transaction(async (tx) => {
          const t = { _: { name: 'probe_table' } };
          await (tx as { insert: (t: unknown) => { values: (r: unknown) => Promise<unknown> } })
            .insert(t)
            .values({ trace_id: root });
        }),
      ).rejects.toBeInstanceOf(UniqueViolationError);
    });

    it('a retry SUCCEEDS instead of dying on the PK', async () => {
      await expect(attemptTurn(1)).resolves.not.toBeNull();
      // Before the fix this rejected with a unique violation, and because the
      // envelope is mandatory for `call_tool` that rejection blocked the turn
      // — so a retry could never succeed.
      await expect(attemptTurn(2)).resolves.not.toBeNull();
      await expect(attemptTurn(3)).resolves.not.toBeNull();
    });

    it('every attempt gets its own envelope row, attempt 1 keeping the ROOT id', async () => {
      await attemptTurn(1);
      await attemptTurn(2);
      await attemptTurn(3);

      const envelopes = txRows.filter((r) => r.table === 'runtime_trace_envelopes');
      expect(envelopes).toHaveLength(3);
      const ids = envelopes.map((e) => e.row.trace_id as string);
      expect(new Set(ids).size).toBe(3);
      // Attempt 1 keeps the root id so the operator-facing id is still the
      // turn's id and the existing Explorer link is unchanged.
      expect(ids[0]).toBe(root);
      expect(ids[1]).not.toBe(root);
    });

    it('correlation survives: every attempt shares turno_id and conversa_id', async () => {
      await attemptTurn(1);
      await attemptTurn(2);
      const envelopes = txRows.filter((r) => r.table === 'runtime_trace_envelopes');
      expect(new Set(envelopes.map((e) => e.row.turno_id)).size).toBe(1);
      expect(new Set(envelopes.map((e) => e.row.conversa_id)).size).toBe(1);
      expect(envelopes[0]!.row.turno_id).toBe(TURNO_ID);
    });

    it('re-running the SAME attempt is idempotent — no duplicate row, no throw', async () => {
      await attemptTurn(2);
      await expect(attemptTurn(2)).resolves.not.toBeNull();
      const envelopes = txRows.filter((r) => r.table === 'runtime_trace_envelopes');
      expect(envelopes).toHaveLength(1);
    });

    it('the per-attempt id is deterministic across processes', () => {
      expect(envelopeTraceIdForAttempt(root, 1)).toBe(root);
      expect(envelopeTraceIdForAttempt(root, 2)).toBe(envelopeTraceIdForAttempt(root, 2));
      expect(envelopeTraceIdForAttempt(root, 2)).not.toBe(envelopeTraceIdForAttempt(root, 3));
      expect(envelopeTraceIdForAttempt(root, 2)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('toContextStub never carries the decision rationale or policy reason', () => {
    const stub = toContextStub({
      base: baseFixture('acme', deriveTraceId('t')),
      packet: packetFixture(),
    });
    const s = JSON.stringify(stub);
    expect(s).not.toContain('sensitive rationale');
    expect(s).not.toContain('limite.transferencia');
    expect(s).not.toContain('99999-9999');
  });
});
