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

import {
  writeEnvelope,
  envelopeSignedPayload,
  ENVELOPE_PAYLOAD_VERSION_V1,
  ENVELOPE_PAYLOAD_VERSION_V2,
  CURRENT_ENVELOPE_PAYLOAD_VERSION,
} from '../../src/control-plane/runtime-trace/envelope-writer.js';
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
   * The payload the writer is EXPECTED to have signed, spelled out here by
   * hand rather than through `envelopeSignedPayload`. A spec that re-used the
   * production builder would agree with the writer by construction — including
   * on the day the builder is wrong.
   */
  function expectedPayload(
    over: Record<string, unknown> = {},
    version: number = CURRENT_ENVELOPE_PAYLOAD_VERSION,
  ) {
    const v1 = {
      trace_id: baseInput.trace_id,
      tenant_id: baseInput.tenant_id,
      agent_id: baseInput.agent_id,
      conversa_id: baseInput.conversa_id,
      turno_id: baseInput.turno_id,
      policy_id: baseInput.decision.policy_id,
      decision: baseInput.decision.decision,
      side_effect_level: baseInput.decision.side_effect_level,
      redaction_class: 'standard',
      hmac_key_version: 1,
    };
    if (version === ENVELOPE_PAYLOAD_VERSION_V1) return { ...v1, ...over };
    return {
      ...v1,
      envelope_payload_version: ENVELOPE_PAYLOAD_VERSION_V2,
      root_trace_id: baseInput.trace_id, // attempt 1 ⇒ own root
      attempt: 1,
      ...over,
    };
  }

  it('HMAC verifies against the canonical envelope payload', async () => {
    const out = await writeEnvelope(baseInput);
    expect(
      verifyHmac(baseInput.tenant_id, out.hmac_key_version, expectedPayload(), out.envelope_hmac),
    ).toBe(true);
  });

  it('tampered side_effect_level fails HMAC verify', async () => {
    const out = await writeEnvelope(baseInput);
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        // ← tampered down from 'medium'
        expectedPayload({ side_effect_level: 'low' }),
        out.envelope_hmac,
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Issue #535 — new writes sign `root_trace_id` + `attempt` (payload v2).
  // ---------------------------------------------------------------------

  it('stamps the payload version on the row and reports it back', async () => {
    const out = await writeEnvelope(baseInput);
    const row = dbInsertMock.mock.calls[0]![0];
    expect(row.envelope_payload_version).toBe(ENVELOPE_PAYLOAD_VERSION_V2);
    expect(out.envelope_payload_version).toBe(ENVELOPE_PAYLOAD_VERSION_V2);
  });

  it('the signature is over the V2 payload, NOT the v1 one', async () => {
    const out = await writeEnvelope(baseInput);
    // The discriminating pair: if the writer still signed v1, the first
    // expectation would fail and the second would pass.
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({}, ENVELOPE_PAYLOAD_VERSION_V2),
        out.envelope_hmac,
      ),
    ).toBe(true);
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({}, ENVELOPE_PAYLOAD_VERSION_V1),
        out.envelope_hmac,
      ),
    ).toBe(false);
  });

  it('a tampered ATTEMPT fails HMAC verify (the #535 gap)', async () => {
    const out = await writeEnvelope({ ...baseInput, attempt: 2, root_trace_id: baseInput.trace_id });
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({ attempt: 2 }),
        out.envelope_hmac,
      ),
    ).toBe(true);
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({ attempt: 1 }), // ← retry re-ordered to look like the first try
        out.envelope_hmac,
      ),
    ).toBe(false);
  });

  it('a tampered ROOT_TRACE_ID fails HMAC verify', async () => {
    const root = '99999999-9999-4999-8999-999999999999';
    const out = await writeEnvelope({ ...baseInput, attempt: 3, root_trace_id: root });
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({ root_trace_id: root, attempt: 3 }),
        out.envelope_hmac,
      ),
    ).toBe(true);
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({ root_trace_id: baseInput.trace_id, attempt: 3 }),
        out.envelope_hmac,
      ),
    ).toBe(false);
  });

  it('two attempts of the same turn get DIFFERENT signatures', async () => {
    const a = await writeEnvelope({ ...baseInput, attempt: 1 });
    const b = await writeEnvelope({ ...baseInput, attempt: 2 });
    // Under v1 these were byte-identical payloads: same trace, same decision,
    // and the only difference (`attempt`) was outside the signature.
    expect(a.envelope_hmac).not.toBe(b.envelope_hmac);
  });

  it('the clamped attempt is what gets SIGNED, not the raw input', async () => {
    // The row and the signature must agree; a clamp applied to one and not the
    // other would write a row that cannot verify itself.
    const out = await writeEnvelope({ ...baseInput, attempt: 0 });
    const row = dbInsertMock.mock.calls[0]![0];
    expect(row.attempt).toBe(1);
    expect(
      verifyHmac(
        baseInput.tenant_id,
        out.hmac_key_version,
        expectedPayload({ attempt: 1 }),
        out.envelope_hmac,
      ),
    ).toBe(true);
  });

  it('the shared payload builder produces exactly what the writer signed', async () => {
    // The other direction of the same claim: `envelopeSignedPayload` is not a
    // second definition that happens to agree — it IS the one the writer used.
    const out = await writeEnvelope(baseInput);
    const row = dbInsertMock.mock.calls[0]![0];
    const rebuilt = envelopeSignedPayload(
      {
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
        root_trace_id: row.root_trace_id,
        attempt: row.attempt,
      },
      row.envelope_payload_version,
    );
    expect(verifyHmac(row.tenant_id, row.hmac_key_version, rebuilt, out.envelope_hmac)).toBe(true);
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
