import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — trace-body-writer worker tests.
 *
 *   - enqueueBody collapses duplicates per trace_id (in-memory accelerator).
 *   - runTraceBodyWriter drains outbox (FOR UPDATE SKIP LOCKED) + memory.
 *   - On writeBody failure (in-memory path), entry is re-enqueued.
 *   - On writeBody failure (outbox path), the outbox row attempts++ is bumped
 *     (Codex review #102 issue 4 — no silent loss).
 *   - Empty queue + empty outbox → no-op.
 */
const { writeBodyMock, dbExecuteMock } = vi.hoisted(() => ({
  writeBodyMock: vi.fn(),
  dbExecuteMock: vi.fn(),
}));

vi.mock('../../src/control-plane/runtime-trace/body-writer.js', () => ({
  writeBody: writeBodyMock,
}));
vi.mock('../../src/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  enqueueBody,
  runTraceBodyWriter,
  _peekQueueSize,
  _resetQueueForTests,
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
    dbExecuteMock.mockReset();
    // Default: outbox claim returns no rows.
    dbExecuteMock.mockResolvedValue({ rows: [] });
    _resetQueueForTests();
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

  it('empty queue + empty outbox is a no-op', async () => {
    await runTraceBodyWriter();
    expect(writeBodyMock).not.toHaveBeenCalled();
  });

  it('on writeBody failure (in-memory), entry is re-enqueued for next tick', async () => {
    writeBodyMock.mockRejectedValueOnce(new Error('db blip'));
    enqueueBody(mk('retry-me'));
    await runTraceBodyWriter();
    // First tick: failed → re-enqueued.
    expect(_peekQueueSize()).toBe(1);
    writeBodyMock.mockResolvedValueOnce(undefined);
    await runTraceBodyWriter();
    expect(_peekQueueSize()).toBe(0);
  });

  // Codex review #102 — issue 4 (durable outbox).
  it('drains outbox rows via FOR UPDATE SKIP LOCKED + deletes on success', async () => {
    // Return one outbox row on the claim query, then succeed on delete.
    dbExecuteMock.mockReset();
    dbExecuteMock
      .mockResolvedValueOnce({
        rows: [
          {
            trace_id: 'outbox-1',
            tenant_id: 'tenant-a',
            agent_id: 'agent-1',
            payload: {
              packet: { trace_id: 'outbox-1', tenant_id: 'tenant-a', agent_id: 'agent-1' },
              decision: { decision: 'allow', side_effect_level: 'medium' },
            },
            redaction_class: 'standard',
            attempts: 0,
          },
        ],
      })
      .mockResolvedValueOnce(undefined); // DELETE

    await runTraceBodyWriter();
    expect(writeBodyMock).toHaveBeenCalledTimes(1);
    expect(writeBodyMock.mock.calls[0]![0]).toMatchObject({ trace_id: 'outbox-1' });
    // SQL inspection: the first execute call claims with SKIP LOCKED.
    const claimSql = JSON.stringify(dbExecuteMock.mock.calls[0]![0]);
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('runtime_trace_body_outbox');
    // The second execute is the DELETE.
    const deleteSql = JSON.stringify(dbExecuteMock.mock.calls[1]![0]);
    expect(deleteSql).toContain('DELETE');
  });

  it('on outbox writeBody failure: row attempts++ bumped (no silent loss)', async () => {
    dbExecuteMock.mockReset();
    dbExecuteMock
      .mockResolvedValueOnce({
        rows: [
          {
            trace_id: 'outbox-fail',
            tenant_id: 'tenant-a',
            agent_id: 'agent-1',
            payload: {
              packet: { trace_id: 'outbox-fail', tenant_id: 'tenant-a', agent_id: 'agent-1' },
              decision: { decision: 'allow', side_effect_level: 'medium' },
            },
            redaction_class: 'standard',
            attempts: 0,
          },
        ],
      })
      .mockResolvedValueOnce(undefined); // attempts bump
    writeBodyMock.mockRejectedValueOnce(new Error('upload failed'));

    await runTraceBodyWriter();
    // Outbox bump SQL fired (UPDATE ... SET attempts = attempts + 1).
    const bumpSql = JSON.stringify(dbExecuteMock.mock.calls[1]![0]);
    expect(bumpSql).toContain('attempts');
    expect(bumpSql).toContain('UPDATE');
  });
});
