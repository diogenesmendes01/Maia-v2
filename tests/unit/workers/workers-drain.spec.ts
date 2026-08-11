/**
 * Issue #512 §6 — cron drain.
 *
 * `stopWorkers()` used to be a synchronous `task.stop()` loop: it stopped
 * FUTURE ticks and returned immediately, so `gracefulShutdown()` went on to
 * close the Redis/Postgres pools underneath a cron run that was still
 * executing (a nightly backup, an outbox drain, a scheduling tick). It also
 * let a slow job overlap itself indefinitely.
 *
 * This suite locks the new contract: no new ticks after the drain starts, no
 * self-overlap, in-flight runs awaited within a deadline, and the ones that
 * blow the deadline REPORTED rather than silently abandoned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSchedule, scheduledTasks } = vi.hoisted(() => {
  const scheduledTasks: { stop: ReturnType<typeof vi.fn> }[] = [];
  const mockSchedule = vi.fn(() => {
    const t = { stop: vi.fn(async () => undefined), start: vi.fn() };
    scheduledTasks.push(t);
    return t;
  });
  return { mockSchedule, scheduledTasks };
});

vi.mock('node-cron', () => ({ default: { schedule: mockSchedule } }));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  stopWorkers,
  startWorkers,
  activeWorkerJobs,
  _internal,
  _resetWorkerStateForTests,
  type Job,
} from '../../../src/workers/index.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function job(name: string, fn: () => Promise<void>): Job {
  return { name, cron: '* * * * *', fn, phase: 1 };
}

beforeEach(() => {
  _resetWorkerStateForTests();
  scheduledTasks.length = 0;
  mockSchedule.mockClear();
});

describe('cron tick guard', () => {
  it('tracks a running job as active and clears it on completion', async () => {
    const d = deferred();
    _internal.runTick(job('slow_job', () => d.promise));
    expect(activeWorkerJobs()).toEqual(['slow_job']);
    d.resolve();
    await new Promise((r) => setImmediate(r));
    expect(activeWorkerJobs()).toEqual([]);
  });

  it('SKIPS a tick whose previous run is still active (no self-overlap)', async () => {
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const j = job('outbox_drain', fn);
    _internal.runTick(j);
    _internal.runTick(j);
    _internal.runTick(j);
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve();
    await new Promise((r) => setImmediate(r));
    // Once the previous run finished, a new tick is accepted again.
    _internal.runTick(job('outbox_drain', vi.fn(async () => undefined)));
    await new Promise((r) => setImmediate(r));
    expect(activeWorkerJobs()).toEqual([]);
  });

  it('a failing job does not wedge the slot forever', async () => {
    _internal.runTick(
      job('flaky', async () => {
        throw new Error('boom');
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(activeWorkerJobs()).toEqual([]);
  });

  it('starts NO new tick once the drain began', async () => {
    const fn = vi.fn(async () => undefined);
    await stopWorkers(50);
    _internal.runTick(job('after_drain', fn));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('stopWorkers — drain semantics', () => {
  it('returns immediately when nothing is in flight', async () => {
    const r = await stopWorkers(1000);
    expect(r).toEqual({ drained: [], pending: [] });
  });

  it('stops every scheduled task', async () => {
    startWorkers(1);
    expect(scheduledTasks.length).toBeGreaterThan(0);
    await stopWorkers(50);
    for (const t of scheduledTasks) expect(t.stop).toHaveBeenCalled();
  });

  it('AWAITS an in-flight run instead of returning under it', async () => {
    const d = deferred();
    let finished = false;
    _internal.runTick(
      job('nightly_backup', async () => {
        await d.promise;
        finished = true;
      }),
    );
    const drain = stopWorkers(2000);
    // Not settled while the job is still running.
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    d.resolve();
    const r = await drain;
    expect(finished).toBe(true);
    expect(r.drained).toEqual(['nightly_backup']);
    expect(r.pending).toEqual([]);
  });

  it('REPORTS the job still active when the deadline expires', async () => {
    _internal.runTick(job('wedged_job', () => new Promise<void>(() => undefined)));
    const r = await stopWorkers(30);
    expect(r.pending).toEqual(['wedged_job']);
    expect(r.drained).toEqual([]);
  });

  it('separates drained from pending when several jobs are in flight', async () => {
    const fast = deferred();
    _internal.runTick(
      job('fast_job', async () => {
        await fast.promise;
      }),
    );
    _internal.runTick(job('stuck_job', () => new Promise<void>(() => undefined)));
    fast.resolve();
    const r = await stopWorkers(40);
    expect(r.pending).toEqual(['stuck_job']);
    expect(r.drained).toEqual(['fast_job']);
  });

  it('is safe to call twice (shutdown is idempotent end-to-end)', async () => {
    startWorkers(1);
    await stopWorkers(50);
    await expect(stopWorkers(50)).resolves.toEqual({ drained: [], pending: [] });
  });
});
