/**
 * Issue #512 review round 1, P1 (`src/index.ts:260`) — end-to-end proof
 * against a REAL Redis that a job enqueued after the drain started never
 * begins a turn.
 *
 * Mocks cannot prove this: the failure mode is BullMQ actually fetching from
 * Redis in the window between the signal and the worker closing. Here the
 * worker is real, the queue is real, and the only thing standing between the
 * job and a side effect is `pauseQueueWorkers()` + the processor drain guard.
 *
 * Skipped without TEST_DB_URL (mirrors the sibling integration specs — the CI
 * job that sets it also brings up Redis).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import {
  agentQueue,
  startAgentWorker,
  pauseQueueWorkers,
  awaitQueueReady,
  shutdownQueue,
} from '@/gateway/queue.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('issue #512 — no job starts after the drain began (real Redis)', () => {
  const processed: string[] = [];

  beforeAll(async () => {
    startAgentWorker(async (job) => {
      processed.push(job.data.mensagem_id);
    });
    await awaitQueueReady();
  }, 30_000);

  afterAll(async () => {
    await shutdownQueue();
    // Leave no test jobs behind for the next spec.
    await agentQueue.obliterate({ force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    processed.length = 0;
    lifecycle._resetForTests();
    lifecycle.transitionTo('ready');
  });

  it('consumes normally while ready (control case — proves the harness works)', async () => {
    await agentQueue.add('process-message', { mensagem_id: 'before-drain' });
    for (let i = 0; i < 60 && !processed.includes('before-drain'); i++) await sleep(100);
    expect(processed).toContain('before-drain');
  }, 20_000);

  it('does NOT start a job enqueued after draining; it stays recoverable in Redis', async () => {
    // Exactly the shutdown's first atomic step.
    lifecycle.transitionTo('draining', 'SIGTERM');
    await pauseQueueWorkers();

    await agentQueue.add('process-message', { mensagem_id: 'after-drain' });
    // Generous window: if the guard were missing, BullMQ would have fetched
    // and run the handler many times over by now.
    await sleep(3000);

    expect(processed).not.toContain('after-drain');

    // …and the work was not lost: it is still waiting/delayed for the next
    // instance, never failed and never DLQ'd.
    const counts = await agentQueue.getJobCounts('waiting', 'delayed', 'active', 'failed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBeGreaterThan(0);
    expect(counts.failed ?? 0).toBe(0);
  }, 20_000);

  it('a job already waiting when the drain starts is deferred, not executed', async () => {
    // Enqueue while paused so the job is sitting in `waiting` when the worker
    // would next fetch — the fetch-in-flight race the processor guard covers.
    await pauseQueueWorkers();
    await agentQueue.add('process-message', { mensagem_id: 'queued-then-drain' });
    lifecycle.transitionTo('draining', 'SIGTERM');
    await sleep(2000);

    expect(processed).not.toContain('queued-then-drain');
    const counts = await agentQueue.getJobCounts('failed');
    expect(counts.failed ?? 0).toBe(0);
  }, 20_000);
});
