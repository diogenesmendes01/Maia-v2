/**
 * Issue #512 review round 1, P1 (`src/index.ts:260`) — BullMQ must stop
 * CONSUMING in the first atomic shutdown step.
 *
 * The hole: the old sequence closed BullMQ in the FOURTH step, after crons,
 * background tasks and the WhatsApp sockets. Neither Worker consulted the
 * lifecycle, so a job enqueued (or fetched) after `draining` still started a
 * full turn — LLM call, tool writes, and an outbound send against a Baileys
 * socket the shutdown had already closed.
 *
 * Two defences, both covered here:
 *   1. `pauseQueueWorkers()` — stop FETCHING immediately (`pause(true)`),
 *      without waiting for the active job (that wait is a later step).
 *   2. `deferIfNotAcceptingWork()` — the residual fetch-in-flight race. A job
 *      handed to the processor after the drain began is re-parked as DELAYED
 *      (recoverable, no attempt consumed, no DLQ row), never executed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { workerCtor, queueCtor, capturedProcessors, DelayedErrorMock } = vi.hoisted(() => {
  const capturedProcessors: Record<string, (job: unknown, token?: string) => Promise<unknown>> = {};
  class DelayedErrorMock extends Error {
    constructor() {
      super('delayed');
      this.name = 'DelayedError';
    }
  }
  const workerCtor = vi.fn(function (
    this: Record<string, unknown>,
    name: string,
    processor: (job: unknown, token?: string) => Promise<unknown>,
  ) {
    capturedProcessors[name] = processor;
    this.name = name;
    this.on = vi.fn();
    this.pause = vi.fn(async () => undefined);
    this.isPaused = vi.fn(() => true);
    this.close = vi.fn(async () => undefined);
    this.waitUntilReady = vi.fn(async () => undefined);
  });
  const queueCtor = vi.fn(function (this: Record<string, unknown>) {
    this.add = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
    this.waitUntilReady = vi.fn(async () => undefined);
    this.getWaitingCount = vi.fn(async () => 0);
  });
  return { workerCtor, queueCtor, capturedProcessors, DelayedErrorMock };
});

vi.mock('bullmq', () => ({
  Worker: workerCtor,
  Queue: queueCtor,
  DelayedError: DelayedErrorMock,
}));
vi.mock('ioredis', () => ({
  default: class {
    status = 'ready';
    on = vi.fn();
    off = vi.fn();
    quit = vi.fn(async () => undefined);
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('../../../src/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../../src/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('../../../src/db/tenant-context.js', () => ({
  runWithSystemContext: (fn: () => Promise<unknown>) => fn(),
}));

import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import {
  startAgentWorker,
  startUnroutedReplayWorker,
  pauseQueueWorkers,
  shutdownQueue,
} from '../../../src/gateway/queue.js';

function fakeJob() {
  return {
    id: 'job-1',
    data: { mensagem_id: 'm-1', unrouted_id: 'u-1' },
    moveToDelayed: vi.fn(async () => undefined),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  lifecycle._resetForTests();
  // Reset the module-level worker singletons between cases.
  await shutdownQueue();
});

describe('agent worker — drain guard', () => {
  it('RUNS the job normally while the lifecycle accepts work', async () => {
    const handler = vi.fn(async () => undefined);
    startAgentWorker(handler);
    lifecycle.transitionTo('ready');
    const job = fakeJob();
    await capturedProcessors.agent!(job, 'tok');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('runs during `starting` too (workers exist before the ready transition)', async () => {
    const handler = vi.fn(async () => undefined);
    startAgentWorker(handler);
    expect(lifecycle.state).toBe('starting');
    await capturedProcessors.agent!(fakeJob(), 'tok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('DEFERS instead of executing once the drain started — no side effect begins', async () => {
    const handler = vi.fn(async () => undefined);
    startAgentWorker(handler);
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining', 'SIGTERM');

    const job = fakeJob();
    await expect(capturedProcessors.agent!(job, 'tok')).rejects.toBeInstanceOf(DelayedErrorMock);
    // The turn never started…
    expect(handler).not.toHaveBeenCalled();
    // …and the job went back to DELAYED with the worker token, so it stays
    // recoverable: no attempt consumed, no DLQ row.
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed.mock.calls[0]![1]).toBe('tok');
    expect(job.moveToDelayed.mock.calls[0]![0]).toBeGreaterThan(Date.now());
  });

  it('is armed SYNCHRONOUSLY with shutdown(), in the same tick, with no await in between', async () => {
    // The guard keys off `#shutdownPromise` (set synchronously by
    // `shutdown()`), not only off the state. Today `#runShutdown` also
    // transitions before its first await, so both signals agree — but the
    // promise is the one that cannot drift: any future refactor that moves the
    // transition behind an await would silently reopen the window for exactly
    // one more job.
    const handler = vi.fn(async () => undefined);
    startAgentWorker(handler);
    lifecycle.transitionTo('ready');
    lifecycle.registerShutdownStep({
      name: 'slow',
      run: () => new Promise(() => undefined),
      timeoutMs: 5,
    });

    expect(lifecycle.isAcceptingWork()).toBe(true);
    void lifecycle.shutdown({ signal: 'SIGTERM' });
    expect(lifecycle.isAcceptingWork()).toBe(false);
    expect(lifecycle.isShuttingDown()).toBe(true);

    const job = fakeJob();
    await expect(capturedProcessors.agent!(job, 'tok')).rejects.toBeInstanceOf(DelayedErrorMock);
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops accepting work in `failed` and `stopped` too', () => {
    lifecycle.transitionTo('failed', 'redis unavailable');
    expect(lifecycle.isAcceptingWork()).toBe(false);
    lifecycle._resetForTests();
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining');
    lifecycle.transitionTo('stopped');
    expect(lifecycle.isAcceptingWork()).toBe(false);
  });

  it('applies the same guard to the unrouted-replay worker', async () => {
    const handler = vi.fn(async () => undefined);
    startUnroutedReplayWorker(handler);
    lifecycle.transitionTo('ready');
    lifecycle.transitionTo('draining');
    const job = fakeJob();
    await expect(capturedProcessors['unrouted-replay']!(job, 'tok')).rejects.toBeInstanceOf(
      DelayedErrorMock,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });
});

describe('pauseQueueWorkers', () => {
  it('pauses BOTH workers with pause(true) — stop fetching, do not wait for active', async () => {
    startAgentWorker(vi.fn(async () => undefined));
    startUnroutedReplayWorker(vi.fn(async () => undefined));
    await pauseQueueWorkers();
    const instances = workerCtor.mock.instances as unknown as {
      pause: ReturnType<typeof vi.fn>;
    }[];
    expect(instances).toHaveLength(2);
    for (const w of instances) {
      expect(w.pause).toHaveBeenCalledWith(true);
    }
  });

  it('is a no-op (never throws) on a process that started no worker', async () => {
    await expect(pauseQueueWorkers()).resolves.toBeUndefined();
  });
});
