import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — trace-body-writer worker tests.
 *
 *   - enqueueBody collapses duplicates per trace_id.
 *   - runTraceBodyWriter drains the queue, calling writeBody once per entry.
 *   - On writeBody failure, the entry is re-enqueued for next tick.
 *   - Empty queue → no-op.
 */
const { writeBodyMock } = vi.hoisted(() => ({ writeBodyMock: vi.fn() }));

vi.mock('../../src/control-plane/runtime-trace/body-writer.js', () => ({
  writeBody: writeBodyMock,
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  enqueueBody,
  runTraceBodyWriter,
  _peekQueueSize,
} from '../../src/workers/trace-body-writer.js';
import type { TraceBodyInput } from '../../src/control-plane/runtime-trace/types.js';

const mk = (id: string): TraceBodyInput => ({
  trace_id: id,
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  packet: { trace_id: id, tenant_id: 'tenant-a', agent_id: 'agent-1' },
  decision: { decision: 'allow', side_effect_level: 'medium' },
  redaction_class: 'standard',
});

describe('trace-body-writer worker', () => {
  beforeEach(async () => {
    writeBodyMock.mockReset();
    writeBodyMock.mockResolvedValue(undefined);
    // Drain whatever's in queue from previous test.
    await runTraceBodyWriter();
    writeBodyMock.mockReset();
    writeBodyMock.mockResolvedValue(undefined);
  });

  it('enqueueBody collapses duplicates by trace_id', () => {
    enqueueBody(mk('t1'));
    enqueueBody(mk('t1'));
    enqueueBody(mk('t2'));
    expect(_peekQueueSize()).toBe(2);
  });

  it('runTraceBodyWriter drains queue and calls writeBody per entry', async () => {
    enqueueBody(mk('a'));
    enqueueBody(mk('b'));
    enqueueBody(mk('c'));
    expect(_peekQueueSize()).toBe(3);
    await runTraceBodyWriter();
    expect(writeBodyMock).toHaveBeenCalledTimes(3);
    expect(_peekQueueSize()).toBe(0);
  });

  it('empty queue is a no-op', async () => {
    await runTraceBodyWriter();
    expect(writeBodyMock).not.toHaveBeenCalled();
  });

  it('on writeBody failure, entry is re-enqueued for next tick', async () => {
    writeBodyMock.mockRejectedValueOnce(new Error('db blip'));
    enqueueBody(mk('retry-me'));
    await runTraceBodyWriter();
    // First tick: failed → re-enqueued.
    expect(_peekQueueSize()).toBe(1);
    writeBodyMock.mockResolvedValueOnce(undefined);
    await runTraceBodyWriter();
    expect(_peekQueueSize()).toBe(0);
  });
});
