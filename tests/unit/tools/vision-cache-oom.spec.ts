/**
 * Issue #309 — Redis OOM handling for the VISION CACHE (`setCachedVision`).
 *
 * Contract proven here:
 *   The vision cache is best-effort; the Vision API / Postgres is the source
 *   of truth (a write miss just means the next identical file re-runs the
 *   Vision call — the read path already returns null on miss). On a Redis OOM
 *   under `noeviction` the write degrades FAIL-OPEN (safe: the key is
 *   tenant+agent-scoped so dropping the write has no isolation impact):
 *     - `setCachedVision` does NOT throw (no raw ReplyError crash),
 *     - `redis_oom_degraded_total{operation="vision_cache.set"}` increments,
 *     - the pre-existing generic `vision_cache.write_failed` fail-open is
 *       preserved for non-OOM errors.
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
      get: vi.fn(async () => null),
      setex: vi.fn(async () => 'OK'),
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

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { setCachedVision } = await import('@/tools/_vision-cache.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  redisStub.setex.mockReset();
  redisStub.setex.mockResolvedValue('OK');
  _resetForTests();
  logWarn.mockClear();
});

describe('vision cache — OOM degradation (#309)', () => {
  it('setCachedVision does NOT throw when setex hits an OOM ReplyError', async () => {
    redisStub.setex.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await expect(
      asTenantA(() => setCachedVision('boleto', 'sha-1', { ok: true })),
    ).resolves.toBeUndefined();
  });

  it('increments redis_oom_degraded_total{operation="vision_cache.set"}', async () => {
    redisStub.setex.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await asTenantA(() => setCachedVision('boleto', 'sha-1', { ok: true }));
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="vision_cache.set"} 1');
  });

  it('does NOT emit the generic vision_cache.write_failed log on OOM (single-counted as OOM)', async () => {
    redisStub.setex.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await asTenantA(() => setCachedVision('boleto', 'sha-1', { ok: true }));
    const writeFailed = logWarn.mock.calls.find((c) => c[1] === 'vision_cache.write_failed');
    expect(writeFailed).toBeUndefined();
    const oom = logWarn.mock.calls.find((c) => c[1] === 'redis.oom_degraded');
    expect(oom).toBeDefined();
  });

  it('a NON-OOM setex error keeps the pre-existing fail-open (warn + no throw, no OOM metric)', async () => {
    redisStub.setex.mockImplementationOnce(async () => {
      throw Object.assign(new Error('READONLY'), { name: 'ReplyError' });
    });
    await expect(
      asTenantA(() => setCachedVision('boleto', 'sha-1', { ok: true })),
    ).resolves.toBeUndefined();
    const writeFailed = logWarn.mock.calls.find((c) => c[1] === 'vision_cache.write_failed');
    expect(writeFailed).toBeDefined();
    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });
});
