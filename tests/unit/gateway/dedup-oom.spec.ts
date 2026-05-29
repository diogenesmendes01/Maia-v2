/**
 * Issue #309 — Redis OOM handling for GATEWAY DEDUP (`markSeen`,
 * `isDuplicate` backfill).
 *
 * Contract proven here (runbook §4.5 + dedup.ts docblock):
 *   The Redis "already seen" marker is a fast-path over the Postgres
 *   source of truth (`mensagensRepo.findByWhatsappId`, tenant+agent-scoped).
 *   On a Redis OOM under `noeviction` the dedup DEGRADES TO THE DB FALLBACK:
 *     - `markSeen` swallows the OOM (no throw to the dispatcher) — identical
 *       to the Redis-down branch; the next `isDuplicate` re-checks the DB so
 *       a real duplicate is STILL detected (no double-processing risk),
 *     - the `isDuplicate` DB-hit backfill swallows the OOM and still returns
 *       `true`,
 *     - `redis_oom_degraded_total{operation="dedup.mark_seen"|"dedup.backfill"}`
 *       increments.
 *   This is fail-SAFE (not fail-open) because Postgres is authoritative.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';

const { redisStub, logWarn } = vi.hoisted(() => {
  // A ReplyError-shaped OOM error. We build it as a plain Error + name rather
  // than importing redis-errors here (the top-level import binding isn't
  // available inside the hoisted factory). `detectOom` recognises both.
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  let setThrowsOom = false;
  const stub = {
    makeOom,
    setSetThrowsOom(v: boolean) {
      setThrowsOom = v;
    },
    exists: vi.fn(async () => 0),
    set: vi.fn(async () => {
      if (setThrowsOom) throw makeOom();
      return 'OK';
    }),
  };
  return { redisStub: stub, logWarn: vi.fn() };
});

function detectOom(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e.code === 'string' && e.code.toUpperCase() === 'OOM') return true;
  const msg = String(e.message ?? '');
  return (e.name === 'ReplyError' && /^\s*OOM\b/i.test(msg)) || /^\s*OOM command not allowed/i.test(msg);
}

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
  isRedisOomError: detectOom,
  recordRedisOomDegraded: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_oom_degraded_total', { operation: caller });
    logWarn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
  },
}));

const findByWhatsappIdMock = vi.fn(async (_id: string) => null as null | { id: string });
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId: findByWhatsappIdMock },
}));

const { isDuplicate, markSeen } = await import('@/gateway/dedup.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WID = 'WID-OOM';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  redisStub.setSetThrowsOom(false);
  redisStub.exists.mockClear();
  redisStub.exists.mockResolvedValue(0);
  redisStub.set.mockClear();
  findByWhatsappIdMock.mockReset();
  findByWhatsappIdMock.mockResolvedValue(null);
  _resetForTests();
  logWarn.mockClear();
});

describe('gateway dedup — OOM degradation (#309)', () => {
  it('markSeen does NOT throw to the caller on an OOM ReplyError', async () => {
    redisStub.setSetThrowsOom(true);
    await expect(asTenantA(() => markSeen(WID))).resolves.toBeUndefined();
  });

  it('markSeen OOM increments redis_oom_degraded_total{operation="dedup.mark_seen"}', async () => {
    redisStub.setSetThrowsOom(true);
    await asTenantA(() => markSeen(WID));
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="dedup.mark_seen"} 1');
  });

  it('isDuplicate still detects a duplicate via DB when the backfill SET hits OOM', async () => {
    // Redis EXISTS misses, DB confirms the duplicate, the backfill SET OOMs.
    // The function must STILL return true (the DB is authoritative) without
    // throwing — degrade-to-DB.
    redisStub.exists.mockResolvedValue(0);
    findByWhatsappIdMock.mockResolvedValue({ id: 'mid-from-db' });
    redisStub.setSetThrowsOom(true);

    const result = await asTenantA(() => isDuplicate(WID));
    expect(result).toBe(true);
    expect(findByWhatsappIdMock).toHaveBeenCalledWith(WID);

    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="dedup.backfill"} 1');
  });

  it('a real duplicate is NOT lost after an OOM markSeen — the next isDuplicate hits the DB', async () => {
    // markSeen OOMs (no cache entry written). The subsequent isDuplicate finds
    // the message in Postgres, proving the dedup contract survives the OOM.
    redisStub.setSetThrowsOom(true);
    await asTenantA(() => markSeen(WID)); // OOM, no-op

    // Next inbound: cache still empty (EXISTS=0), DB now has the row.
    redisStub.exists.mockResolvedValue(0);
    findByWhatsappIdMock.mockResolvedValue({ id: 'mid-from-db' });
    const dup = await asTenantA(() => isDuplicate(WID));
    expect(dup).toBe(true);
  });

  it('a NON-OOM SET error still propagates from markSeen', async () => {
    const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
    redisStub.set.mockImplementationOnce(async () => {
      throw boom;
    });
    await expect(asTenantA(() => markSeen(WID))).rejects.toBe(boom);
    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });
});
