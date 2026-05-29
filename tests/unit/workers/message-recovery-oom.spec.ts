/**
 * Issue #309 follow-up (PR #324 B1) — message-recovery sweep fail-closed
 * behaviour when `enqueueAgent` cannot reach Redis.
 *
 * Contract proven here:
 *   `runMessageRecovery` re-enqueues inbound rows stranded with
 *   `processada_em IS NULL`. It NEVER marks a row processed (it has no such
 *   capability — only `enqueueAgent` is called), so a failed enqueue always
 *   leaves the row pending for the next sweep. On a Redis OOM the sweep stops
 *   early (`break`) instead of hammering a memory-capped Redis; on a non-OOM
 *   error it logs per message and continues with the rest of the batch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { enqueueAgentMock, listUnprocessedMock, logWarn, logInfo } = vi.hoisted(() => ({
  enqueueAgentMock: vi.fn(async () => undefined),
  listUnprocessedMock: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

// Re-use the real typed error so `instanceof` in the worker matches.
class QueueRedisUnavailableError extends Error {
  readonly code = 'QUEUE_REDIS_UNAVAILABLE';
  readonly oom: boolean;
  constructor(opts?: { oom?: boolean }) {
    super('test queue unavailable');
    this.name = 'QueueRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: enqueueAgentMock,
  QueueRedisUnavailableError,
}));
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: { listUnprocessedOlderThan: listUnprocessedMock },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: logInfo, error: vi.fn(), debug: vi.fn() },
}));
// runWithTenantContext just needs to invoke the inner fn.
vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>) => fn(),
}));

const { runMessageRecovery } = await import('@/workers/message-recovery.js');

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  enqueueAgentMock.mockReset();
  enqueueAgentMock.mockResolvedValue(undefined);
  listUnprocessedMock.mockReset();
  logWarn.mockClear();
  logInfo.mockClear();
});

describe('message recovery — fail-closed enqueue (#309 / PR #324 B1)', () => {
  it('aborts the sweep on the FIRST OOM (does not enqueue the rest of the batch)', async () => {
    listUnprocessedMock.mockResolvedValue(rows('m1', 'm2', 'm3'));
    // First row OOMs; remaining rows must NOT be attempted.
    enqueueAgentMock.mockImplementationOnce(async () => {
      throw new QueueRedisUnavailableError({ oom: true });
    });

    await runMessageRecovery();

    expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
    expect(enqueueAgentMock).toHaveBeenCalledWith({ mensagem_id: 'm1' });
    // breadcrumb log identifies the abort
    const aborted = logWarn.mock.calls.find((c) => c[1] === 'message_recovery.aborted_redis_unavailable');
    expect(aborted).toBeTruthy();
    expect(aborted![0]).toMatchObject({ mensagem_id: 'm1', oom: true });
  });

  it('continues past a NON-OOM error and processes the rest of the batch', async () => {
    listUnprocessedMock.mockResolvedValue(rows('m1', 'm2', 'm3'));
    const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
    enqueueAgentMock.mockImplementationOnce(async () => {
      throw boom; // m1 fails (non-OOM)
    });
    // m2, m3 succeed.

    await runMessageRecovery();

    expect(enqueueAgentMock).toHaveBeenCalledTimes(3);
    const failed = logWarn.mock.calls.find((c) => c[1] === 'message_recovery.enqueue_failed');
    expect(failed).toBeTruthy();
    expect(failed![0]).toMatchObject({ mensagem_id: 'm1' });
    // 2 of 3 re-queued — the poison row did not stall the others.
    const done = logInfo.mock.calls.find((c) => c[1] === 'message_recovery.done');
    expect(done![0]).toMatchObject({ requeued: 2, scanned: 3 });
  });

  it('happy path re-enqueues every stuck row', async () => {
    listUnprocessedMock.mockResolvedValue(rows('m1', 'm2'));
    await runMessageRecovery();
    expect(enqueueAgentMock).toHaveBeenCalledTimes(2);
    const done = logInfo.mock.calls.find((c) => c[1] === 'message_recovery.done');
    expect(done![0]).toMatchObject({ requeued: 2, scanned: 2 });
  });

  it('no rows → no enqueue attempts', async () => {
    listUnprocessedMock.mockResolvedValue([]);
    await runMessageRecovery();
    expect(enqueueAgentMock).not.toHaveBeenCalled();
  });
});
