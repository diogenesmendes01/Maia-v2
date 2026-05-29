/**
 * Issue #309 — Redis OOM handling for OUTBOX BACKPRESSURE
 * (`tryAcquireSendSlot`).
 *
 * Contract proven here (module docblock — Redis is REQUIRED; the gate is
 * FAIL-CLOSED to avoid burst-banning the WhatsApp account):
 *   On a Redis OOM under `noeviction` the gate denies the send with a
 *   dedicated `redis_oom` reason (NOT fail-open — silently allowing could
 *   double-send or burst-ban). The outbox row stays `pending` (the
 *   `outbox-drain` caller maps the reason to a backoff) and the next tick
 *   retries. A raw `ReplyError` never escapes to crash the drain loop.
 *     - returns `{ kind: 'deny', reason: 'redis_oom' }`,
 *     - increments `redis_oom_degraded_total{operation="backpressure.acquire"}`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { incCounter } from '@/lib/metrics.js';

const { redisStub, logWarn } = vi.hoisted(() => {
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  return {
    redisStub: {
      makeOom,
      set: vi.fn(async () => 'OK'),
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
    },
    logWarn: vi.fn(),
  };
});

function detectOom(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e.code === 'string' && e.code.toUpperCase() === 'OOM') return true;
  const msg = String(e.message ?? '');
  return (e.name === 'ReplyError' && /^\s*OOM\b/i.test(msg)) || /^\s*OOM command not allowed/i.test(msg);
}

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
  isRedisOomError: detectOom,
  recordRedisOomDegraded: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_oom_degraded_total', { operation: caller });
    logWarn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
  },
}));

vi.mock('@/config/env.js', () => ({
  config: { OUTBOX_MAX_PER_SECOND: 10, OUTBOX_MAX_PER_HOUR: 1000 },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { tryAcquireSendSlot } = await import('@/scheduling/backpressure.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const JID = 'a@s.whatsapp.net';

beforeEach(() => {
  redisStub.set.mockReset();
  redisStub.set.mockResolvedValue('OK');
  redisStub.incr.mockReset();
  redisStub.incr.mockResolvedValue(1);
  redisStub.expire.mockReset();
  redisStub.expire.mockResolvedValue(1);
  redisStub.del.mockReset();
  redisStub.del.mockResolvedValue(1);
  _resetForTests();
  logWarn.mockClear();
});

describe('backpressure — OOM fail-closed (#309)', () => {
  it('denies with reason "redis_oom" when the pace SET hits OOM', async () => {
    redisStub.set.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    const decision = await tryAcquireSendSlot(JID);
    expect(decision).toEqual({ kind: 'deny', reason: 'redis_oom' });
  });

  it('denies with reason "redis_oom" when a bucket INCR hits OOM', async () => {
    redisStub.set.mockResolvedValue('OK');
    redisStub.incr.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    const decision = await tryAcquireSendSlot(JID);
    expect(decision).toEqual({ kind: 'deny', reason: 'redis_oom' });
  });

  it('does NOT throw to the caller on OOM (no raw ReplyError escapes)', async () => {
    redisStub.set.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await expect(tryAcquireSendSlot(JID)).resolves.toBeDefined();
  });

  it('increments redis_oom_degraded_total{operation="backpressure.acquire"}', async () => {
    redisStub.set.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await tryAcquireSendSlot(JID);
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="backpressure.acquire"} 1');
  });

  it('a NON-OOM Redis error still propagates from the gate', async () => {
    const boom = Object.assign(new Error('READONLY'), { name: 'ReplyError' });
    redisStub.set.mockImplementationOnce(async () => {
      throw boom;
    });
    await expect(tryAcquireSendSlot(JID)).rejects.toBe(boom);
    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });
});
