import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — envelope writer tests (sync hot path).
 *
 * Tests:
 *   1. Returns envelope-written shape with HMAC + key version.
 *   2. HMAC is over canonical payload (insertion order doesn't matter).
 *   3. Throws when DB insert fails (caller MUST abort side effect).
 *   4. Different tenants get different HMACs for the same payload.
 *   5. Latency tracked (sync_latency_ms populated).
 *   6. With outbox_body option: writes envelope + outbox in one tx.
 */
const { dbInsertMock, txInsertOnConflictMock, txInsertValuesMock, dbTransactionMock } = vi.hoisted(() => {
  const txInsertOnConflictMock = vi.fn().mockResolvedValue(undefined);
  const txInsertValuesMock = vi.fn();
  return {
    dbInsertMock: vi.fn().mockResolvedValue(undefined),
    txInsertOnConflictMock,
    txInsertValuesMock,
    dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      // Drizzle's tx.insert(table).values(...) returns a thenable that
      // also has .onConflictDoNothing(). Our mock returns a chain that
      // supports both terminal awaits (envelope) and the on-conflict
      // chain (outbox). The values mock is called for each insert so
      // tests can inspect it.
      let inserts = 0;
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn((row: unknown) => {
            inserts += 1;
            txInsertValuesMock(row);
            // Return a chain object that:
            //  - awaits to undefined (envelope path),
            //  - has .onConflictDoNothing() that returns a promise (outbox path).
            const chain = {
              then: (resolve: (v: unknown) => void) => resolve(undefined),
              onConflictDoNothing: () => {
                txInsertOnConflictMock();
                // Non-empty RETURNING ⇒ the row was inserted, no replay.
                const rows = [{ trace_id: 'inserted' }];
                return {
                  then: (res: (v: unknown) => void) => res(rows),
                  returning: () => Promise.resolve(rows),
                };
              },
            } as unknown;
            return chain;
          }),
        })),
      };
      await fn(tx);
      // Sanity: tx didn't run? Push to make tests fail clearly.
      if (inserts === 0) throw new Error('test mock: no inserts ran in tx');
    }),
  };
});

// Mock drizzle db.insert(...).values(...) chain + db.transaction.
vi.mock('../../src/db/client.js', () => ({
  db: {
    // Issue #514 review round 1 [P1]: the non-transactional path is now
    // `insert(...).values(...).onConflictDoNothing()` (at-least-once callers
    // must not die on a duplicate PK). `dbInsertMock` stays the row recorder
    // and outcome control — `mockRejectedValue` still simulates a DB failure —
    // and the chain simply forwards its promise to whichever terminal the
    // writer uses.
    insert: () => ({
      values: (row: unknown) => {
        const p = dbInsertMock(row) as Promise<unknown>;
        return {
          then: (res: (v: unknown) => void, rej: (e: unknown) => void) => p.then(res, rej),
          // #514 round 2: the writer asks for RETURNING to detect a replay. A
          // non-empty result means "inserted", which is the default here — the
          // divergent-replay path has its own spec with a PK-modelling fake.
          onConflictDoNothing: () => ({
            then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
              p.then(() => res([{ trace_id: 'inserted' }]), rej),
            returning: () => p.then(() => [{ trace_id: 'inserted' }]),
          }),
        };
      },
    }),
    transaction: dbTransactionMock,
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'p10b-envelope-writer-unit-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
  },
}));

import { writeEnvelope } from '../../src/control-plane/runtime-trace/envelope-writer.js';
import {
  verifyHmac,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
} from '../../src/control-plane/runtime-trace/lib/hmac.js';
import type {
  TraceEnvelopeInput,
  TraceBodyInput,
} from '../../src/control-plane/runtime-trace/types.js';

const baseInput: TraceEnvelopeInput = {
  trace_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  conversa_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  turno_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  decision: {
    decision: 'allow',
    side_effect_level: 'medium',
    policy_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  },
};

describe('writeEnvelope', () => {
  beforeEach(() => {
    dbInsertMock.mockReset();
    dbInsertMock.mockResolvedValue(undefined);
    txInsertValuesMock.mockClear();
    txInsertOnConflictMock.mockClear();
    dbTransactionMock.mockClear();
    _resetHmacCacheForTests();
    _setTestMasterSecretForTests('p10b-envelope-writer-unit-secret');
  });

  it('writes the envelope and returns the HMAC + version', async () => {
    const out = await writeEnvelope(baseInput);
    expect(dbInsertMock).toHaveBeenCalledTimes(1);
    expect(out.trace_id).toBe(baseInput.trace_id);
    expect(out.decision).toBe('allow');
    expect(out.side_effect_level).toBe('medium');
    expect(out.envelope_hmac).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(out.hmac_key_version).toBeGreaterThan(0);
    expect(out.sync_latency_ms).toBeGreaterThanOrEqual(0);
    expect(out.redaction_class).toBe('standard');
  });

  /**
   * Issue #535 — this payload is written out LITERALLY on purpose.
   *
   * The obvious version of this test rebuilds the expected material by calling
   * `envelopeSignedPayload()`, the same function the writer calls. That test
   * passes whatever the writer signs, including nothing at all: signer and
   * "expectation" move together. A literal is the only form in which the SET of
   * signed fields is asserted rather than echoed — drop `root_trace_id` from the
   * production material and this goes red, because the literal still has it.
   */
  const RETRY_INPUT: TraceEnvelopeInput = {
    ...baseInput,
    root_trace_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    attempt: 3,
  };

  function v2MaterialLiteral(hmac_key_version: number) {
    return {
      trace_id: RETRY_INPUT.trace_id,
      tenant_id: RETRY_INPUT.tenant_id,
      agent_id: RETRY_INPUT.agent_id,
      conversa_id: RETRY_INPUT.conversa_id,
      turno_id: RETRY_INPUT.turno_id,
      policy_id: RETRY_INPUT.decision.policy_id,
      decision: RETRY_INPUT.decision.decision,
      side_effect_level: RETRY_INPUT.decision.side_effect_level,
      redaction_class: 'standard',
      hmac_key_version,
      // The two fields the owner decision adds, plus the version that makes a
      // relabel detectable.
      root_trace_id: RETRY_INPUT.root_trace_id,
      attempt: RETRY_INPUT.attempt,
      signature_version: 2,
    };
  }

  it('HMAC verifies against the canonical v2 envelope payload', async () => {
    const out = await writeEnvelope(RETRY_INPUT);
    expect(
      verifyHmac(
        RETRY_INPUT.tenant_id,
        out.hmac_key_version,
        v2MaterialLiteral(out.hmac_key_version),
        out.envelope_hmac,
      ),
    ).toBe(true);
  });

  it('a forged root_trace_id does not verify against what production signed', async () => {
    const out = await writeEnvelope(RETRY_INPUT);
    const forged = {
      ...v2MaterialLiteral(out.hmac_key_version),
      root_trace_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    };
    expect(
      verifyHmac(RETRY_INPUT.tenant_id, out.hmac_key_version, forged, out.envelope_hmac),
    ).toBe(false);
  });

  it('a forged attempt does not verify against what production signed', async () => {
    const out = await writeEnvelope(RETRY_INPUT);
    const forged = { ...v2MaterialLiteral(out.hmac_key_version), attempt: 99 };
    expect(
      verifyHmac(RETRY_INPUT.tenant_id, out.hmac_key_version, forged, out.envelope_hmac),
    ).toBe(false);
  });

  it('production writes signature_version=2 on the ROW, and never v1', async () => {
    const out = await writeEnvelope(RETRY_INPUT);
    const row = dbInsertMock.mock.calls[0]![0];
    expect(row.signature_version).toBe(2);
    expect(out.signature_version).toBe(2);
    // And the stored HMAC is genuinely the v2 material, not a v1 one carrying a
    // "2" label: the v1 material must NOT reproduce it.
    const v1Material = { ...v2MaterialLiteral(out.hmac_key_version) } as Record<string, unknown>;
    delete v1Material.root_trace_id;
    delete v1Material.attempt;
    delete v1Material.signature_version;
    expect(
      verifyHmac(RETRY_INPUT.tenant_id, out.hmac_key_version, v1Material, out.envelope_hmac),
    ).toBe(false);
  });

  it('the signature version is NOT caller-controlled (no downgrade oracle)', async () => {
    // A caller that smuggles a version through the input must not get a v1
    // envelope out: the writer takes it from a constant.
    const out = await writeEnvelope({
      ...RETRY_INPUT,
      // @ts-expect-error — deliberately passing a field the input type refuses
      signature_version: 1,
    });
    expect(out.signature_version).toBe(2);
    expect(dbInsertMock.mock.calls[0]![0].signature_version).toBe(2);
  });

  it('tampered side_effect_level fails HMAC verify', async () => {
    const out = await writeEnvelope(RETRY_INPUT);
    const tampered = {
      ...v2MaterialLiteral(out.hmac_key_version),
      side_effect_level: 'low', // ← tampered down from 'medium'
    };
    expect(
      verifyHmac(RETRY_INPUT.tenant_id, out.hmac_key_version, tampered, out.envelope_hmac),
    ).toBe(false);
  });

  it('throws when DB insert fails — caller MUST abort the side effect', async () => {
    dbInsertMock.mockRejectedValue(new Error('connection refused'));
    await expect(writeEnvelope(baseInput)).rejects.toThrow('connection refused');
  });

  it('different tenants get different HMACs for the same trace payload', async () => {
    const a = await writeEnvelope({ ...baseInput, tenant_id: 'tenant-a' });
    const b = await writeEnvelope({ ...baseInput, tenant_id: 'tenant-b' });
    expect(a.envelope_hmac).not.toBe(b.envelope_hmac);
  });

  it('honors redaction_class override on input', async () => {
    const out = await writeEnvelope({ ...baseInput, redaction_class: 'debug' });
    expect(out.redaction_class).toBe('debug');
  });

  it('stamps body_status=pending on the insert (for recoverer)', async () => {
    await writeEnvelope(baseInput);
    const row = dbInsertMock.mock.calls[0]![0];
    expect(row.body_status).toBe('pending');
    expect(row.envelope_hmac).toBeDefined();
  });

  // Codex review #102 — issue 4 (durable outbox).
  it('with outbox_body option: envelope + outbox row written in one transaction', async () => {
    const bodyInput: TraceBodyInput = {
      trace_id: baseInput.trace_id,
      tenant_id: baseInput.tenant_id,
      agent_id: baseInput.agent_id,
      packet: { trace_id: baseInput.trace_id, tenant_id: baseInput.tenant_id, agent_id: baseInput.agent_id },
      decision: baseInput.decision,
      redaction_class: 'standard',
    };
    await writeEnvelope(baseInput, { outbox_body: bodyInput });
    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
    // 2 .values() calls inside the tx: envelopes + outbox.
    expect(txInsertValuesMock).toHaveBeenCalledTimes(2);
    // Issue #514 review round 1 [P1]: BOTH inserts are conflict-tolerant now
    // — the envelope as well as the outbox. An at-least-once re-write of the
    // same attempt must be a no-op, not a unique violation that fails the
    // turn closed.
    expect(txInsertOnConflictMock).toHaveBeenCalledTimes(2);
    // Non-tx insert path NOT used when outbox_body is set.
    expect(dbInsertMock).not.toHaveBeenCalled();
    // Inspect what got inserted — envelope first (has body_status), outbox second (has payload).
    const firstRow = txInsertValuesMock.mock.calls[0]![0];
    const secondRow = txInsertValuesMock.mock.calls[1]![0];
    expect(firstRow.body_status).toBe('pending');
    expect(firstRow.envelope_hmac).toBeDefined();
    expect(secondRow.payload).toBeDefined();
    expect(secondRow.redaction_class).toBe('standard');
  });
});
