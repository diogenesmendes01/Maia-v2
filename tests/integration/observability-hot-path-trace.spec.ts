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

const { dbInsertValuesMock, dbExecuteMock, dbTransactionMock, txRows } = vi.hoisted(() => {
  const txRows: Array<{ table: string; row: Record<string, unknown> }> = [];
  return {
    txRows,
    dbInsertValuesMock: vi.fn().mockResolvedValue(undefined),
    dbExecuteMock: vi.fn().mockResolvedValue({ rows: [] }),
    dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn((table: { _?: { name?: string } }) => ({
          values: vi.fn((row: Record<string, unknown>) => {
            txRows.push({ table: table?._?.name ?? 'unknown', row });
            return {
              then: (resolve: (v: unknown) => void) => resolve(undefined),
              onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            };
          }),
        })),
      };
      await fn(tx);
    }),
  };
});

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

const { traceTurnDecision, toContextStub } = await import('@/observability/turn-trace.js');
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

    const envelope = txRows[0]!.row;
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
    const trace_id = deriveTraceId('turn-e2e-2');
    await traceTurnDecision({ base: baseFixture('tenant-a', trace_id), packet: packetFixture() });
    const hmacA = txRows[0]!.row.envelope_hmac as string;

    txRows.length = 0;
    await traceTurnDecision({ base: baseFixture('tenant-b', trace_id), packet: packetFixture() });
    const hmacB = txRows[0]!.row.envelope_hmac as string;

    expect(hmacA).not.toBe(hmacB);
  });

  it('the envelope HMAC verifies against its own signed payload', async () => {
    const trace_id = deriveTraceId('turn-e2e-3');
    await traceTurnDecision({ base: baseFixture('acme', trace_id), packet: packetFixture() });
    const row = txRows[0]!.row;

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

    const outbox = txRows[1]!.row;
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
    dbTransactionMock.mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(
      traceTurnDecision({
        base: baseFixture('acme', deriveTraceId('turn-e2e-5')),
        packet: packetFixture({ action_mode: 'call_tool' }),
      }),
    ).rejects.toThrow('postgres unavailable');
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
      expect(txRows[0]!.row.trace_id).toBe(trace_id);
    });
  });

  it('two attempts at the same turn share ONE envelope trace id', async () => {
    const trace_id = deriveTraceId('turn-e2e-8');
    const ids: unknown[] = [];
    for (const attempt of [1, 2]) {
      txRows.length = 0;
      await runWithCorrelation(
        { seed: 'turn-e2e-8', turn_id: 'turn-e2e-8', attempt, origin: 'recovery' },
        async () => {
          await traceTurnDecision({
            base: baseFixture('acme', trace_id),
            packet: packetFixture(),
          });
          ids.push(txRows[0]!.row.trace_id);
        },
      );
    }
    expect(new Set(ids).size).toBe(1);
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
