import { describe, it, expect, vi, beforeEach } from 'vitest';

const isRedisConnectedMock = vi.fn();
const redisMock = {
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/lib/redis.js', () => ({
  isRedisConnected: () => isRedisConnectedMock(),
  redis: redisMock,
}));

vi.mock('../../src/config/env.js', () => ({
  config: { OUTBOX_MAX_PER_SECOND: 1, OUTBOX_MAX_PER_HOUR: 5 },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  isRedisConnectedMock.mockReset();
  isRedisConnectedMock.mockReturnValue(true);
  redisMock.set.mockReset();
  redisMock.incr.mockReset();
  redisMock.expire.mockReset();
  redisMock.del.mockReset();
  redisMock.expire.mockResolvedValue(1);
  redisMock.del.mockResolvedValue(1);
});

describe('tryAcquireSendSlot — Requirement 2', () => {
  it('fails CLOSED when Redis is disconnected', async () => {
    isRedisConnectedMock.mockReturnValue(false);
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    expect(await tryAcquireSendSlot('jid@s.whatsapp.net')).toEqual({
      kind: 'deny',
      reason: 'redis_down',
    });
  });

  it('allows when all three gates pass (pace SET NX OK, sec=1, hour=1)', async () => {
    redisMock.set.mockResolvedValue('OK');
    redisMock.incr
      .mockResolvedValueOnce(1) // per-second
      .mockResolvedValueOnce(1); // per-hour
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    expect(await tryAcquireSendSlot('a@s.whatsapp.net')).toEqual({ kind: 'allow' });
  });

  it('denies with reason per_recipient when SET NX returns null', async () => {
    redisMock.set.mockResolvedValue(null);
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    expect(await tryAcquireSendSlot('a@s.whatsapp.net')).toEqual({
      kind: 'deny',
      reason: 'per_recipient',
    });
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('denies with reason per_second when second bucket exceeds limit', async () => {
    redisMock.set.mockResolvedValue('OK');
    redisMock.incr.mockResolvedValueOnce(2); // > 1
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    expect(await tryAcquireSendSlot('a@s.whatsapp.net')).toEqual({
      kind: 'deny',
      reason: 'per_second',
    });
    // Issue #287: jid is now URI-encoded inside the cache key so `@` → `%40`.
    expect(redisMock.del).toHaveBeenCalledWith('outbox:pace:a%40s.whatsapp.net');
  });

  it('denies with reason per_hour when hour bucket exceeds limit', async () => {
    redisMock.set.mockResolvedValue('OK');
    redisMock.incr
      .mockResolvedValueOnce(1) // per-second OK
      .mockResolvedValueOnce(6); // per-hour > 5
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    expect(await tryAcquireSendSlot('a@s.whatsapp.net')).toEqual({
      kind: 'deny',
      reason: 'per_hour',
    });
  });

  it('simulating 10k backlog: when per-second is exhausted, subsequent attempts deny — never burst', async () => {
    redisMock.set.mockResolvedValue('OK');
    redisMock.incr
      .mockResolvedValueOnce(1) // first attempt: sec=1
      .mockResolvedValueOnce(1) // first attempt: hour=1
      .mockResolvedValueOnce(2); // second attempt same second: sec=2 → deny
    const { tryAcquireSendSlot } = await import('../../src/scheduling/backpressure.js');
    const first = await tryAcquireSendSlot('a@s.whatsapp.net');
    const second = await tryAcquireSendSlot('b@s.whatsapp.net');
    expect(first).toEqual({ kind: 'allow' });
    expect(second).toEqual({ kind: 'deny', reason: 'per_second' });
  });
});
