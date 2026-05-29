/**
 * Issue #309 — Redis OOM handling for BOT DETECTION (`checkBotAndMaybeBlock`).
 *
 * Contract proven here:
 *   The flood counter is a best-effort heuristic with NO Postgres source of
 *   truth. On a Redis OOM under `noeviction` it DEGRADES to "don't block"
 *   (returns `false`) — identical to the Redis-down skip and the existing
 *   generic-failure branch. Failing to increment the counter must never block
 *   a legitimate user, and a raw `ReplyError` must never crash the ingress.
 *     - `checkBotAndMaybeBlock` returns `false` (does NOT throw, does NOT block),
 *     - `redis_oom_degraded_total{operation="bot_detection.incr"}` increments.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';

const { redisStub, logWarn } = vi.hoisted(() => {
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  return {
    redisStub: {
      makeOom,
      incr: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
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
  recordRedisError: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_error_total', { operation: caller });
    logWarn({ redis_error: true, caller, ...extra }, 'redis.error');
  },
}));

const findByPhoneMock = vi.fn();
const updateStatusMock = vi.fn();
vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: { findByPhone: findByPhoneMock, updateStatus: updateStatusMock },
}));

const auditMock = vi.fn(async () => undefined);
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { checkBotAndMaybeBlock } = await import('@/gateway/bot-detection.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE = '+5511999999999';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  redisStub.incr.mockReset();
  redisStub.incr.mockResolvedValue(1);
  redisStub.expire.mockReset();
  redisStub.expire.mockResolvedValue(1);
  findByPhoneMock.mockReset();
  updateStatusMock.mockReset();
  _resetForTests();
  logWarn.mockClear();
});

describe('bot detection — OOM degradation (#309)', () => {
  it('returns false (does NOT block) when INCR hits an OOM ReplyError', async () => {
    redisStub.incr.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    const result = await asTenantA(() => checkBotAndMaybeBlock(PHONE));
    expect(result).toBe(false);
    // Never consulted the DB or blocked anyone on the degraded path.
    expect(findByPhoneMock).not.toHaveBeenCalled();
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('does NOT throw to the caller on OOM', async () => {
    redisStub.incr.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await expect(asTenantA(() => checkBotAndMaybeBlock(PHONE))).resolves.toBe(false);
  });

  it('increments redis_oom_degraded_total{operation="bot_detection.incr"}', async () => {
    redisStub.incr.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await asTenantA(() => checkBotAndMaybeBlock(PHONE));
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="bot_detection.incr"} 1');
  });

  it('a NON-OOM Redis error still degrades (false) but is now VISIBLE via redis_error_total (#324 B2)', async () => {
    redisStub.incr.mockImplementationOnce(async () => {
      throw Object.assign(new Error('READONLY'), { name: 'ReplyError' });
    });
    const result = await asTenantA(() => checkBotAndMaybeBlock(PHONE));
    expect(result).toBe(false);
    const out = await renderPrometheus();
    // Fail-open behaviour unchanged, but the fault is no longer invisible:
    // a distinct error counter fires (NOT the OOM counter).
    expect(out).toContain('redis_error_total{operation="bot_detection.incr"} 1');
    expect(out).not.toContain('redis_oom_degraded_total');
    // And it is still logged structurally.
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, agent_id: AGENT_A }),
      'bot_detection.redis_failed',
    );
  });
});
