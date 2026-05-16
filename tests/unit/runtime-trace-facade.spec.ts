import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — trace() facade tests.
 *
 * Tests:
 *   1. Flag OFF → no-op envelope returned, no DB write, no enqueue.
 *   2. Flag ON  → envelope written sync, body enqueued.
 *   3. envelopeIsRequired() table: medium/high/critical → true; others → false.
 */
const { dbInsertMock, isEnabledMock, enqueueMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  isEnabledMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { insert: () => ({ values: dbInsertMock }) },
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

import { trace } from '../../src/control-plane/runtime-trace/index.js';
import { envelopeIsRequired } from '../../src/control-plane/runtime-trace/types.js';
import { _resetHmacCacheForTests } from '../../src/control-plane/runtime-trace/lib/hmac.js';

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
    enqueueMock.mockReset();
    isEnabledMock.mockReset();
    _resetHmacCacheForTests();
  });

  it('flag OFF: no-op envelope returned, no DB write, no enqueue', async () => {
    isEnabledMock.mockReturnValue(false);
    const out = await trace(baseInput);
    expect(out.envelope_hmac).toBe('');
    expect(out.hmac_key_version).toBe(0);
    expect(out.decision).toBe('allow');
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('flag ON: envelope written, body enqueued, hmac populated', async () => {
    isEnabledMock.mockReturnValue(true);
    const out = await trace(baseInput);
    expect(dbInsertMock).toHaveBeenCalledTimes(1);
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
