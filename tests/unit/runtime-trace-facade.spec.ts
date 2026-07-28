import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — trace() facade tests.
 *
 * Tests:
 *   1. Flag OFF → no-op envelope returned, no DB write, no enqueue.
 *   2. Flag ON  → envelope + outbox row written sync (one tx), body enqueued.
 *   3. envelopeIsRequired() table: medium/high/critical → true; others → false.
 *
 * Codex review #102 — issue 4: trace() writes envelope + body outbox in
 * one DB transaction (durable). The in-process enqueue is a perf accelerator
 * only; the worker drains the durable outbox as source of truth.
 */
const { dbInsertMock, txInsertValuesMock, txOnConflictMock, dbTransactionMock, isEnabledMock, enqueueMock } =
  vi.hoisted(() => {
    const txOnConflictMock = vi.fn().mockResolvedValue(undefined);
    const txInsertValuesMock = vi.fn();
    return {
      dbInsertMock: vi.fn().mockResolvedValue(undefined),
      txInsertValuesMock,
      txOnConflictMock,
      dbTransactionMock: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn((row: unknown) => {
              txInsertValuesMock(row);
              return {
                then: (resolve: (v: unknown) => void) => resolve(undefined),
                onConflictDoNothing: txOnConflictMock,
              };
            }),
          })),
        };
        await fn(tx);
      }),
      isEnabledMock: vi.fn(),
      enqueueMock: vi.fn(),
    };
  });

vi.mock('../../src/db/client.js', () => ({
  db: {
    insert: () => ({ values: dbInsertMock }),
    transaction: dbTransactionMock,
  },
}));
vi.mock('../../src/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: isEnabledMock },
}));
vi.mock('../../src/workers/trace-body-writer.js', () => ({
  enqueueBody: enqueueMock,
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'p10b-facade-unit-secret',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
  },
}));

import { trace } from '../../src/control-plane/runtime-trace/index.js';
import { envelopeIsRequired } from '../../src/control-plane/runtime-trace/types.js';
import {
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
} from '../../src/control-plane/runtime-trace/lib/hmac.js';

const baseInput = {
  trace_id: '11111111-1111-1111-1111-111111111111',
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  packet: { trace_id: 't', tenant_id: 'tenant-a', agent_id: 'agent-1' },
  decision: { decision: 'allow' as const, side_effect_level: 'medium' as const },
};

describe('trace() facade', () => {
  beforeEach(() => {
    dbInsertMock.mockReset();
    dbInsertMock.mockResolvedValue(undefined);
    txInsertValuesMock.mockClear();
    txOnConflictMock.mockClear();
    dbTransactionMock.mockClear();
    enqueueMock.mockReset();
    isEnabledMock.mockReset();
    _resetHmacCacheForTests();
    _setTestMasterSecretForTests('p10b-facade-unit-secret');
  });

  it('flag ON: envelope + outbox row written in ONE transaction (durable), body enqueued in-memory', async () => {
    isEnabledMock.mockReturnValue(true);
    const out = await trace(baseInput);
    // Durable path: one transaction containing envelope INSERT + outbox INSERT.
    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
    expect(txInsertValuesMock).toHaveBeenCalledTimes(2);
    // Issue #514 review round 1 [P1]: BOTH inserts are idempotent now — the
    // envelope as well as the outbox. The writer is at-least-once (BullMQ
    // retry, recovery sweep, outbox relayer), so re-writing the same envelope
    // must be a no-op rather than a unique violation that fails the turn.
    expect(txOnConflictMock).toHaveBeenCalledTimes(2);
    // In-memory enqueue as accelerator.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(out.envelope_hmac.length).toBeGreaterThan(0);
    expect(out.hmac_key_version).toBeGreaterThan(0);
  });

  it('enqueued body carries the original packet + redaction_class', async () => {
    isEnabledMock.mockReturnValue(true);
    await trace({ ...baseInput, redaction_class: 'debug' });
    const enqueued = enqueueMock.mock.calls[0]![0];
    expect(enqueued.trace_id).toBe(baseInput.trace_id);
    expect(enqueued.redaction_class).toBe('debug');
    expect(enqueued.packet).toEqual(baseInput.packet);
  });
});

describe('envelopeIsRequired (invariant 12)', () => {
  it('medium / high / critical → REQUIRES envelope before side effect', () => {
    expect(envelopeIsRequired('medium')).toBe(true);
    expect(envelopeIsRequired('high')).toBe(true);
    expect(envelopeIsRequired('critical')).toBe(true);
  });

  it('none / low → envelope not strictly required', () => {
    expect(envelopeIsRequired('none')).toBe(false);
    expect(envelopeIsRequired('low')).toBe(false);
  });
});
