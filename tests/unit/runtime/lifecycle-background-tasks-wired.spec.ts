/**
 * Issue #512 review round 1, P1 — the background-task registry has to be
 * WIRED, not just tested in isolation.
 *
 * The finding: the drain awaited the registry, but no production call site fed
 * it. Post-turn reflection, the DLQ writer and the primary-line registration
 * stayed invisible, so the `background_tasks` step always returned "nothing
 * pending" while critical work was live. A step that observes nothing always
 * passes — the test was green for the wrong reason.
 *
 * This suite asserts the wiring end-to-end: the REAL `registerShutdownSequence()`
 * step must block on work registered from a production path, and the real
 * `worker.on('failed')` handler must register its DLQ write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, dlqAddMock, auditMock, workerCtor, failedHandlers } = vi.hoisted(() => {
  const calls: string[] = [];
  const failedHandlers: ((job: unknown, err: unknown) => void)[] = [];
  const dlqAddMock = vi.fn();
  const auditMock = vi.fn(async () => undefined);
  const workerCtor = vi.fn(function (this: Record<string, unknown>, name: string) {
    this.name = name;
    this.on = vi.fn((evt: string, fn: (job: unknown, err: unknown) => void) => {
      if (evt === 'failed') failedHandlers.push(fn);
    });
    this.pause = vi.fn(async () => undefined);
    this.isPaused = vi.fn(() => false);
    this.close = vi.fn(async () => undefined);
    this.waitUntilReady = vi.fn(async () => undefined);
  });
  return { calls, dlqAddMock, auditMock, workerCtor, failedHandlers };
});

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('bullmq', () => ({
  Worker: workerCtor,
  Queue: class {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    waitUntilReady = vi.fn(async () => undefined);
    getWaitingCount = vi.fn(async () => 0);
  },
  DelayedError: class extends Error {},
}));
vi.mock('ioredis', () => ({
  default: class {
    status = 'ready';
    on = vi.fn();
    off = vi.fn();
    quit = vi.fn(async () => undefined);
  },
}));
vi.mock('../../../src/db/repositories.js', () => ({ dlqRepo: { add: dlqAddMock } }));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('../../../src/db/tenant-context.js', () => ({
  runWithSystemContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../../src/workers/index.js', () => ({
  startWorkers: vi.fn(),
  haltWorkerScheduling: vi.fn(async () => undefined),
  drainWorkers: vi.fn(async () => ({ drained: [], pending: [] })),
}));
vi.mock('../../../src/gateway/line-sessions.js', () => ({
  shutdownLineSessions: vi.fn(async () => undefined),
  startAdditionalLineSessions: vi.fn(async () => undefined),
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  shutdownBaileys: vi.fn(async () => void calls.push('baileys_closed')),
  startBaileys: vi.fn(async () => undefined),
  isBaileysConnected: () => true,
  getLastDisconnectAt: () => null,
}));
vi.mock('../../../src/lib/healthcheck.js', () => ({
  shutdownPools: vi.fn(async () => void calls.push('pools_closed')),
}));

import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import { registerShutdownSequence } from '../../../src/runtime/lifecycle/shutdown-sequence.js';
import { startAgentWorker, shutdownQueue } from '../../../src/gateway/queue.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  calls.length = 0;
  failedHandlers.length = 0;
  vi.clearAllMocks();
  lifecycle._resetForTests();
  await shutdownQueue();
});

describe('background_tasks step — observes REAL work', () => {
  it('BLOCKS the drain until a tracked task finishes, and blocks it before the sockets close', async () => {
    registerShutdownSequence();
    const work = deferred();
    let finished = false;
    lifecycle.trackBackgroundTask(
      'postturn_reflection',
      work.promise.then(() => {
        finished = true;
        calls.push('postturn_done');
      }),
    );

    const draining = lifecycle.shutdown({ signal: 'SIGTERM' });
    await new Promise((r) => setTimeout(r, 50));
    // Still parked on the background task — nothing downstream ran.
    expect(finished).toBe(false);
    expect(calls).not.toContain('baileys_closed');
    expect(calls).not.toContain('pools_closed');

    work.resolve();
    const out = await draining;
    expect(out.result).toBe('clean');
    // The turn's tail completed BEFORE the transport and the pools closed.
    expect(calls.indexOf('postturn_done')).toBeLessThan(calls.indexOf('baileys_closed'));
    expect(calls.indexOf('postturn_done')).toBeLessThan(calls.indexOf('pools_closed'));
  }, 20_000);

  it('reports the task by name when it outlives the deadline (drain = incomplete)', async () => {
    registerShutdownSequence();
    lifecycle.trackBackgroundTask('postturn_reflection', new Promise<void>(() => undefined));
    const out = await lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(out.result).toBe('incomplete');
    expect(out.undrained).toContain('background_tasks');
  }, 30_000);
});

describe('DLQ writer — registered from the real BullMQ failed handler', () => {
  it('tracks the DLQ write so the drain waits for it', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    expect(failedHandlers).toHaveLength(1);

    const dlqWrite = deferred();
    dlqAddMock.mockReturnValue(dlqWrite.promise.then(() => ({ id: 'dlq-1' })));

    // A job that exhausted its retries.
    failedHandlers[0]!({ id: 'j1', data: { mensagem_id: 'm1' }, attemptsMade: 3, opts: {} }, new Error('boom'));

    expect(lifecycle.countBackgroundTasks()).toBe(1);
    expect(lifecycle.pendingBackgroundTaskNames()).toContain('dlq_write');

    dlqWrite.resolve();
    await expect(lifecycle.awaitBackgroundTasks(2000)).resolves.toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ acao: 'dlq_job_added' }));
  });

  it('does NOT register anything for a job that still has retries left', () => {
    startAgentWorker(vi.fn(async () => undefined));
    failedHandlers[0]!({ id: 'j1', data: {}, attemptsMade: 1, opts: { attempts: 3 } }, new Error('x'));
    expect(lifecycle.countBackgroundTasks()).toBe(0);
    expect(dlqAddMock).not.toHaveBeenCalled();
  });

  it('a failing DLQ write does not leave the drain hanging', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    dlqAddMock.mockRejectedValue(new Error('db gone'));
    failedHandlers[0]!({ id: 'j1', data: {}, attemptsMade: 3, opts: {} }, new Error('boom'));
    await expect(lifecycle.awaitBackgroundTasks(2000)).resolves.toEqual([]);
  });
});
