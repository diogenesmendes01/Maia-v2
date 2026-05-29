/**
 * Issue #309 follow-up (PR #324 B1) — Redis OOM handling for `enqueueAgent`.
 *
 * Contract proven here:
 *   `enqueueAgent` is the BullMQ enqueue path used by the NON-debounced
 *   ingress (`baileys.ts`) and the message-recovery sweep
 *   (`workers/message-recovery.ts`). The DLQ only catches jobs that already
 *   EXIST (`worker.on('failed')`), so an OOM on `agentQueue.add` — which
 *   happens BEFORE the job is created — would otherwise escape as an
 *   unhandled `ReplyError` and strand the message. This is FAIL-CLOSED:
 *     - a raw ioredis OOM `ReplyError` is converted to a typed
 *       `QueueRedisUnavailableError` (oom === true) — no raw crash,
 *     - `redis_oom_degraded_total{operation="enqueue_agent"}` increments,
 *     - the inbound row is left untouched (caller leaves it PERSISTED /
 *       `processada_em IS NULL`) so `runMessageRecovery` re-enqueues it later.
 *   A NON-OOM error (conn reset, WRONGTYPE, auth) propagates UNCHANGED so a
 *   real Redis bug stays visible — it is NOT swallowed and NOT relabelled.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { incCounter } from '@/lib/metrics.js';

const { queueAdd, logWarn, makeOom } = vi.hoisted(() => {
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  return { queueAdd: vi.fn(async () => undefined), logWarn: vi.fn(), makeOom };
});

function detectOom(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e.code === 'string' && e.code.toUpperCase() === 'OOM') return true;
  const msg = String(e.message ?? '');
  return (e.name === 'ReplyError' && /^\s*OOM\b/i.test(msg)) || /^\s*OOM command not allowed/i.test(msg);
}

// `queue.ts` only consumes `isRedisOomError` + `recordRedisOomDegraded` from
// the redis module — mock those so we exercise the real detection logic + the
// real metric (via incCounter) without opening an ioredis socket.
vi.mock('@/lib/redis.js', () => ({
  isRedisOomError: detectOom,
  recordRedisOomDegraded: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_oom_degraded_total', { operation: caller });
    logWarn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
  },
}));

// Stub BullMQ so importing `queue.ts` (which does `new Queue(...)` at module
// load) doesn't touch a real broker; `add` is the controllable seam.
vi.mock('bullmq', () => {
  class FakeQueue {
    add = queueAdd;
    close = vi.fn(async () => undefined);
  }
  class FakeWorker {
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
vi.mock('@/db/repositories.js', () => ({ dlqRepo: { add: vi.fn() } }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { enqueueAgent, QueueRedisUnavailableError } = await import('@/gateway/queue.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

beforeEach(() => {
  queueAdd.mockReset();
  queueAdd.mockResolvedValue(undefined);
  logWarn.mockClear();
  _resetForTests();
});

describe('enqueueAgent — OOM fail-closed (#309 / PR #324 B1)', () => {
  it('converts a BullMQ add OOM into a typed QueueRedisUnavailableError (oom=true)', async () => {
    queueAdd.mockImplementationOnce(async () => {
      throw makeOom();
    });
    await expect(enqueueAgent({ mensagem_id: 'm1' })).rejects.toMatchObject({
      code: 'QUEUE_REDIS_UNAVAILABLE',
      oom: true,
    });
  });

  it('the thrown error is a QueueRedisUnavailableError instance (no raw ReplyError escapes)', async () => {
    queueAdd.mockImplementationOnce(async () => {
      throw makeOom();
    });
    await enqueueAgent({ mensagem_id: 'm1' }).catch((err) => {
      expect(err).toBeInstanceOf(QueueRedisUnavailableError);
      expect((err as Error).name).toBe('QueueRedisUnavailableError');
    });
  });

  it('increments redis_oom_degraded_total{operation="enqueue_agent"} on OOM', async () => {
    queueAdd.mockImplementationOnce(async () => {
      throw makeOom();
    });
    await enqueueAgent({ mensagem_id: 'm1' }).catch(() => {});
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="enqueue_agent"} 1');
  });

  it('does NOT mark the message done / does NOT retry the add itself on OOM (single add, fail-closed)', async () => {
    queueAdd.mockImplementationOnce(async () => {
      throw makeOom();
    });
    await enqueueAgent({ mensagem_id: 'm1' }).catch(() => {});
    // Exactly one add attempt — we fail closed and defer to the recovery
    // sweep rather than busy-retrying against a memory-capped Redis.
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it('a NON-OOM error propagates UNCHANGED (not swallowed, not relabelled, no OOM metric)', async () => {
    const boom = Object.assign(new Error('WRONGTYPE Operation against a key'), { name: 'ReplyError' });
    queueAdd.mockImplementationOnce(async () => {
      throw boom;
    });
    // The exact same error object surfaces — proves we did not wrap or swallow.
    await expect(enqueueAgent({ mensagem_id: 'm1' })).rejects.toBe(boom);
    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });

  it('a connection-reset error also propagates UNCHANGED', async () => {
    const reset = Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' });
    queueAdd.mockImplementationOnce(async () => {
      throw reset;
    });
    await expect(enqueueAgent({ mensagem_id: 'm2' })).rejects.toBe(reset);
  });

  it('the happy path still enqueues with retry/backoff opts', async () => {
    await enqueueAgent({ mensagem_id: 'ok' });
    expect(queueAdd).toHaveBeenCalledWith(
      'process-message',
      { mensagem_id: 'ok' },
      expect.objectContaining({ attempts: 3, backoff: { type: 'exponential', delay: 2000 } }),
    );
  });
});
