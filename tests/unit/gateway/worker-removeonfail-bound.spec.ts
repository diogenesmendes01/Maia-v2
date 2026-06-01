/**
 * Issue #349 — bound BullMQ failed-job retention on the consumer Worker.
 *
 * Contract proven here:
 *   `startAgentWorker` does `new Worker('agent', processor, opts)`. The opts
 *   historically set `removeOnComplete` but left failed jobs unbounded (kept
 *   "by default" for DLQ inspection), so a failed-job pile could grow in Redis
 *   until manual cleanup. The Worker now mirrors the producer with a GENEROUS
 *   `removeOnFail: { count: 1000, age: 7d }` bound — failed jobs age out while
 *   keeping enough recent history for DLQ inspection.
 *
 *   Stub BullMQ so importing `queue.ts` (which does `new Queue(...)` at module
 *   load and `new Worker(...)` in `startAgentWorker`) doesn't touch a real
 *   broker; the captured `Worker` ctor opts are the seam under test. Mirrors
 *   the `tests/unit/gateway/queue-oom.spec.ts` stubbing pattern.
 */
import { describe, it, expect, vi } from 'vitest';

const EXPECTED_REMOVE_ON_FAIL = { count: 1000, age: 7 * 24 * 3600 };
const EXPECTED_REMOVE_ON_COMPLETE = { age: 86_400 };

const { workerOpts } = vi.hoisted(() => ({ workerOpts: { current: null as unknown } }));

vi.mock('bullmq', () => {
  class FakeQueue {
    add = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  }
  class FakeWorker {
    constructor(_name: string, _processor: unknown, opts: unknown) {
      workerOpts.current = opts;
    }
    on = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

vi.mock('ioredis', () => {
  class FakeRedis {
    on() {
      return this;
    }
    quit = vi.fn(async () => undefined);
  }
  return { default: FakeRedis };
});

vi.mock('@/config/env.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('@/lib/redis.js', () => ({
  isRedisOomError: () => false,
  recordRedisOomDegraded: vi.fn(),
}));
vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { startAgentWorker } = await import('@/gateway/queue.js');

describe('agent Worker opts — bounded failed-job retention (#349)', () => {
  it('configures removeOnFail with the generous { count: 1000, age: 7d } bound', () => {
    startAgentWorker(async () => undefined);
    const opts = workerOpts.current as Record<string, unknown>;
    expect(opts.removeOnFail).toEqual(EXPECTED_REMOVE_ON_FAIL);
  });

  it('keeps removeOnComplete alongside removeOnFail (symmetry, no bound dropped)', () => {
    startAgentWorker(async () => undefined);
    const opts = workerOpts.current as Record<string, unknown>;
    expect(opts.removeOnComplete).toEqual(EXPECTED_REMOVE_ON_COMPLETE);
    expect(opts.removeOnFail).toEqual(EXPECTED_REMOVE_ON_FAIL);
  });
});
