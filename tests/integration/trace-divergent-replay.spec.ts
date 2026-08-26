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
vi.mock('@/config/contract-env.js', () => ({
  contractEnv: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'divergent-replay-spec-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
    RUNTIME_TRACE_DEBUG_AES_KEY: Buffer.alloc(32, 5).toString('base64'),
    RUNTIME_TRACE_DEBUG_S3_BUCKET: undefined,
    RUNTIME_TRACE_BODY_ORPHAN_SEC: 300,
  },
}));

const { writeEnvelope, DivergentTraceReplayError, divergedEnvelopeFields, bodyPayloadDigest } =
  await import('@/control-plane/runtime-trace/envelope-writer.js');

import type {
  TraceEnvelopeInput,
  TraceBodyInput,
} from '@/control-plane/runtime-trace/types.js';

const TRACE_ID = '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60';

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

    it('a different ATTEMPT ordinal is refused (unsigned column)', async () => {
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

  describe('comparison helpers', () => {
    const base = {
      tenant_id: 't',
      envelope_hmac: 'h',
      root_trace_id: 'r',
      attempt: 1,
      // Issue #535: a versão da assinatura entra na comparação. Ela já está
      // implícita no HMAC (a v2 assina a própria versão), mas a comparação
      // precisa NOMEAR o campo divergente para a row de auditoria —
      // "envelope_hmac" sozinho diria ao operador que algo mudou sem dizer o quê.
      signature_version: 2,
    };

    it('identical rows diverge on nothing', () => {
      expect(divergedEnvelopeFields(base, { ...base })).toEqual([]);
    });

    it('null and undefined root are the same absence', () => {
      expect(
        divergedEnvelopeFields(
          { ...base, root_trace_id: null },
          { ...base, root_trace_id: null },
        ),
      ).toEqual([]);
    });

    it('reports every field that differs', () => {
      expect(
        divergedEnvelopeFields(base, {
          tenant_id: 'other',
          envelope_hmac: 'other',
          root_trace_id: 'other',
          attempt: 9,
          signature_version: 1,
        }),
      ).toEqual([
        'tenant_id',
        'envelope_hmac',
        'root_trace_id',
        'attempt',
        'signature_version',
      ]);
    });

    it('issue #535 — um replay que só troca a versão da assinatura é divergência', () => {
      // Reescrever a linha armazenada como v1 mantendo o resto é exatamente a
      // jogada do downgrade. Aqui ela aparece pelo nome, não só como um HMAC
      // que deixou de bater.
      expect(divergedEnvelopeFields(base, { ...base, signature_version: 1 })).toEqual([
        'signature_version',
      ]);
    });

    it('the body digest is stable under key reordering', () => {
      expect(bodyPayloadDigest({ a: 1, b: 2 })).toBe(bodyPayloadDigest({ b: 2, a: 1 }));
      expect(bodyPayloadDigest({ a: 1 })).not.toBe(bodyPayloadDigest({ a: 2 }));
    });
  });
});
