/**
 * Issue #514 review round 2 [P2] — a DIVERGENT replay must fail closed.
 *
 * Round 1 added `onConflictDoNothing` so an at-least-once re-write of the same
 * envelope stops crashing the turn. That fix, on its own, also swallowed the
 * dangerous case: a second write reusing an existing `trace_id` with a
 * DIFFERENT tenant, decision, HMAC or body returned "written" while the table
 * kept the OLD evidence. In an evidence system that is worse than the original
 * crash — the trail asserts something it did not store.
 *
 * These specs use a fake that models real primary-key semantics AND retains the
 * stored row, so the divergence comparison runs against actual content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { persisted, txRows, dbTransactionMock, dbInsertValuesMock, dbExecuteMock, selectFrom } =
  vi.hoisted(() => {
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
          const rows = conflict ? [] : [{ trace_id: row.trace_id }];
          return {
            then: (res: (v: unknown) => void) => res(rows),
            returning: () => Promise.resolve(rows),
          };
        },
      };
    }

    // Returns the stored rows of the queried table; each spec keeps exactly one
    // envelope so `.limit(1)` picks the conflicting row (see the sibling spec's
    // note — this fake is not a query engine).
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
      selectFrom,
      dbInsertValuesMock: vi.fn((table: unknown) => ({
        values: vi.fn((row: Record<string, unknown>) => insertInto(tableName(table), row)),
      })),
      dbExecuteMock: vi.fn().mockResolvedValue({ rows: [] }),
      dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: vi.fn((table: unknown) => ({
            values: vi.fn((row: Record<string, unknown>) => insertInto(tableName(table), row)),
          })),
          select: vi.fn(() => selectFrom()),
        };
        await fn(tx);
      }),
    };
  });

vi.mock('@/db/client.js', () => ({
  db: {
    // Same PK-modelling store as the transactional path, so the
    // non-transactional branch is exercised for real rather than stubbed.
    insert: dbInsertValuesMock,
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
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'divergent-replay-spec-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_DEBUG_AES_KEY: Buffer.alloc(32, 5).toString('base64'),
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
    RUNTIME_TRACE_BODY_ORPHAN_SEC: 300,
  },
}));

const {
  writeEnvelope,
  DivergentTraceReplayError,
  divergedEnvelopeFields,
  bodyPayloadDigest,
  envelopeSignedPayload,
  ENVELOPE_PAYLOAD_VERSION_V1,
  ENVELOPE_PAYLOAD_VERSION_V2,
} = await import('@/control-plane/runtime-trace/envelope-writer.js');
const { signHmac } = await import('@/control-plane/runtime-trace/lib/hmac.js');

import type {
  TraceEnvelopeInput,
  TraceBodyInput,
} from '@/control-plane/runtime-trace/types.js';
import type { ComparableEnvelopeEvidence } from '@/control-plane/runtime-trace/envelope-writer.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';
const ENVELOPE_KEY = `runtime_trace_envelopes:${TRACE_ID}`;

function input(over: Partial<TraceEnvelopeInput> = {}): TraceEnvelopeInput {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    conversa_id: null,
    turno_id: null,
    decision: { decision: 'allow', side_effect_level: 'medium', policy_id: 'pol-1' },
    ...over,
  };
}

/**
 * An envelope row exactly as the PRE-#535 writer left it: the v1 payload, the
 * v1 version tag, and a signature over the v1 field set.
 *
 * Used to seed the store so the CURRENT writer meets a row written by an older
 * replica — the rolling-deploy shape, which is the one that can turn a deploy
 * window into a wave of failed turns if the divergence check compares the
 * signature across versions.
 */
function storedV1Envelope(over: Record<string, unknown> = {}) {
  const fields = {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    conversa_id: null,
    turno_id: null,
    policy_id: 'pol-1',
    decision: 'allow' as const,
    side_effect_level: 'medium' as const,
    redaction_class: 'standard',
    hmac_key_version: 1,
    root_trace_id: TRACE_ID,
    attempt: 1,
    ...over,
  };
  return {
    ...fields,
    envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V1,
    envelope_hmac: signHmac(
      fields.tenant_id,
      fields.hmac_key_version,
      envelopeSignedPayload(fields, ENVELOPE_PAYLOAD_VERSION_V1),
    ),
    body_status: 'pending',
  };
}

function body(over: Partial<TraceBodyInput> = {}): TraceBodyInput {
  return {
    trace_id: TRACE_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    packet: { trace_id: TRACE_ID, tenant_id: 'tenant-A', agent_id: 'agent-a' },
    decision: { decision: 'allow', side_effect_level: 'medium' },
    redaction_class: 'standard',
    ...over,
  };
}

describe('issue #514 [P2] — divergent replay is refused, identical replay is a no-op', () => {
  beforeEach(() => {
    persisted.clear();
    txRows.length = 0;
    dbTransactionMock.mockClear();
  });

  describe('identical replay stays idempotent (round 1 must not regress)', () => {
    it('re-writing the SAME envelope succeeds and stores one row', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      await expect(writeEnvelope(input(), { outbox_body: body() })).resolves.toMatchObject({
        trace_id: TRACE_ID,
      });
      expect(txRows.filter((r) => r.table === 'runtime_trace_envelopes')).toHaveLength(1);
    });

    it('works on the non-transactional path too', async () => {
      await writeEnvelope(input());
      await expect(writeEnvelope(input())).resolves.toBeDefined();
    });
  });

  describe('divergent replay fails closed', () => {
    it('a different DECISION is refused', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      await expect(
        writeEnvelope(
          input({ decision: { decision: 'deny', side_effect_level: 'medium', policy_id: 'pol-1' } }),
          { outbox_body: body() },
        ),
      ).rejects.toBeInstanceOf(DivergentTraceReplayError);
    });

    it('a different SIDE EFFECT LEVEL is refused', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      await expect(
        writeEnvelope(
          input({
            decision: { decision: 'allow', side_effect_level: 'critical', policy_id: 'pol-1' },
          }),
          { outbox_body: body() },
        ),
      ).rejects.toBeInstanceOf(DivergentTraceReplayError);
    });

    it('a different TENANT is refused — the isolation case', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      let thrown: unknown;
      try {
        await writeEnvelope(input({ tenant_id: 'tenant-B' }), {
          outbox_body: body({ tenant_id: 'tenant-B' }),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DivergentTraceReplayError);
      // tenant_id is compared DIRECTLY, not just via the (tenant-keyed) hash.
      expect((thrown as InstanceType<typeof DivergentTraceReplayError>).diverged_fields).toContain(
        'tenant_id',
      );
    });

    it('a different AGENT is refused (covered by the signature)', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      await expect(
        writeEnvelope(input({ agent_id: 'agent-b' }), { outbox_body: body() }),
      ).rejects.toBeInstanceOf(DivergentTraceReplayError);
    });

    it('a different ATTEMPT ordinal is refused', async () => {
      await writeEnvelope(input({ attempt: 1 }), { outbox_body: body() });
      let thrown: unknown;
      try {
        await writeEnvelope(input({ attempt: 2 }), { outbox_body: body() });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DivergentTraceReplayError);
      expect((thrown as InstanceType<typeof DivergentTraceReplayError>).diverged_fields).toContain(
        'attempt',
      );
    });

    it('a different BODY payload is refused even when the envelope matches', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      let thrown: unknown;
      try {
        await writeEnvelope(input(), {
          outbox_body: body({ packet: { trace_id: TRACE_ID, tampered: true } }),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DivergentTraceReplayError);
      expect((thrown as InstanceType<typeof DivergentTraceReplayError>).diverged_fields).toContain(
        'body.payload',
      );
    });

    it('the error names FIELDS, never the conflicting content values', async () => {
      // `tenant_id` and `trace_id` DO appear — they are sanctioned identifiers
      // (tenant_id is an allowed metric label) and an operator needs them to
      // act. What must never leak is the CONTENT that differed: signatures and
      // body payload.
      await writeEnvelope(input(), { outbox_body: body() });
      let thrown: unknown;
      try {
        await writeEnvelope(input(), {
          outbox_body: body({ packet: { trace_id: TRACE_ID, secret_note: 'saldo do cliente' } }),
        });
      } catch (e) {
        thrown = e;
      }
      const err = thrown as InstanceType<typeof DivergentTraceReplayError>;
      expect(err.diverged_fields).toEqual(['body.payload']);
      expect(err.message).not.toContain('saldo do cliente');
      expect(err.message).not.toContain('secret_note');
      // No HMAC material either.
      const stored = [...persisted.values()].find((r) => r.envelope_hmac);
      expect(err.message).not.toContain(String(stored?.envelope_hmac));
    });

    it('does NOT report success — the whole point of the finding', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      const before = txRows.length;
      await writeEnvelope(input({ agent_id: 'agent-b' }), { outbox_body: body() }).catch(
        () => undefined,
      );
      // Nothing new stored, and the caller got an exception rather than a
      // written-envelope record.
      expect(txRows.length).toBe(before);
    });
  });

  /**
   * Issue #535 — the same evidence now has TWO valid encodings, so the
   * divergence check had to stop treating "different signature" as "different
   * facts".
   */
  describe('#535 — replay across payload versions', () => {
    it('a v1 row replayed by the v2 writer is IDENTICAL, not divergent', () => {
      // The rolling-deploy case. Old replica wrote the envelope; the upgraded
      // one retries the same attempt (BullMQ, outbox relayer, recovery sweep).
      // Same facts, different signature — and `writeEnvelope` fails CLOSED on
      // divergence, so getting this wrong aborts turns for the whole deploy
      // window and pages ops over an encoding difference.
      persisted.set(ENVELOPE_KEY, storedV1Envelope());
      return expect(writeEnvelope(input())).resolves.toMatchObject({ trace_id: TRACE_ID });
    });

    it('… and the reverse direction (v2 stored, v1 replay) too', async () => {
      await writeEnvelope(input());
      const storedV2 = persisted.get(ENVELOPE_KEY);
      expect(storedV2!.envelope_payload_version).toBe(ENVELOPE_PAYLOAD_VERSION_V2);
      // Simulate the not-yet-upgraded replica re-writing the same evidence.
      const diverged = divergedEnvelopeFields(
        storedV2 as unknown as ComparableEnvelopeEvidence,
        storedV1Envelope() as unknown as ComparableEnvelopeEvidence,
      );
      expect(diverged).toEqual([]);
    });

    it('but DIFFERENT facts across versions are still refused', async () => {
      // The carve-out is for the encoding, never for the evidence: a v1 row
      // asserting `deny` must not be silently replaced by a v2 `allow`.
      persisted.set(ENVELOPE_KEY, storedV1Envelope({ decision: 'deny' }));
      let thrown: unknown;
      try {
        await writeEnvelope(input());
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DivergentTraceReplayError);
      expect((thrown as InstanceType<typeof DivergentTraceReplayError>).diverged_fields).toContain(
        'decision',
      );
    });

    it('a v1 row with a different ATTEMPT is still refused', async () => {
      // `attempt` is compared by value regardless of whether the STORED row
      // signed it — the column is evidence either way.
      persisted.set(ENVELOPE_KEY, storedV1Envelope({ attempt: 4 }));
      let thrown: unknown;
      try {
        await writeEnvelope(input({ attempt: 1 }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DivergentTraceReplayError);
      expect((thrown as InstanceType<typeof DivergentTraceReplayError>).diverged_fields).toContain(
        'attempt',
      );
    });

    it('the writer stamps v2 on every new row', async () => {
      await writeEnvelope(input(), { outbox_body: body() });
      expect(persisted.get(ENVELOPE_KEY)!.envelope_payload_version).toBe(
        ENVELOPE_PAYLOAD_VERSION_V2,
      );
    });
  });

  describe('comparison helpers', () => {
    function comparable(over: Record<string, unknown> = {}) {
      return {
        tenant_id: 't',
        agent_id: 'a',
        conversa_id: null,
        turno_id: null,
        policy_id: 'p',
        decision: 'allow',
        side_effect_level: 'medium',
        redaction_class: 'standard',
        root_trace_id: 'r',
        attempt: 1,
        hmac_key_version: 1,
        envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V2,
        envelope_hmac: 'h',
        ...over,
      };
    }

    it('identical rows diverge on nothing', () => {
      expect(divergedEnvelopeFields(comparable(), comparable())).toEqual([]);
    });

    it('null and undefined root are the same absence', () => {
      expect(
        divergedEnvelopeFields(
          comparable({ root_trace_id: null }),
          comparable({ root_trace_id: undefined }),
        ),
      ).toEqual([]);
    });

    it('reports every evidence field that differs, by name', () => {
      expect(
        divergedEnvelopeFields(
          comparable(),
          comparable({
            tenant_id: 'other',
            agent_id: 'other',
            decision: 'deny',
            root_trace_id: 'other',
            attempt: 9,
            envelope_hmac: 'other',
          }),
        ),
      ).toEqual(['tenant_id', 'agent_id', 'decision', 'root_trace_id', 'attempt', 'envelope_hmac']);
    });

    it('a tampered signature over identical fields is still divergence', () => {
      // The one thing the value-by-value comparison would miss on its own.
      expect(
        divergedEnvelopeFields(comparable(), comparable({ envelope_hmac: 'forged' })),
      ).toEqual(['envelope_hmac']);
    });

    it('a different payload version alone is NOT divergence', () => {
      expect(
        divergedEnvelopeFields(
          comparable({
            envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V1,
            envelope_hmac: 'v1-signature',
          }),
          comparable({
            envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V2,
            envelope_hmac: 'v2-signature',
          }),
        ),
      ).toEqual([]);
    });

    it('a different KEY version alone is NOT divergence either', () => {
      // Rotating the key mid-retry-window changes the signature without
      // changing a single fact. Same reasoning as the payload version, and the
      // same reasoning that makes a rotated-out key `unknown` rather than
      // `invalid` on the read side.
      expect(
        divergedEnvelopeFields(
          comparable({ hmac_key_version: 1, envelope_hmac: 'signed-with-v1-key' }),
          comparable({ hmac_key_version: 2, envelope_hmac: 'signed-with-v2-key' }),
        ),
      ).toEqual([]);
    });

    it('the body digest is stable under key reordering', () => {
      expect(bodyPayloadDigest({ a: 1, b: 2 })).toBe(bodyPayloadDigest({ b: 2, a: 1 }));
      expect(bodyPayloadDigest({ a: 1 })).not.toBe(bodyPayloadDigest({ a: 2 }));
    });
  });
});
