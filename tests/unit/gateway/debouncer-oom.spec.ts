/**
 * Issue #309 — Redis OOM handling for the DEBOUNCER.
 *
 * Contract proven here:
 *   The debouncer is FAIL-CLOSED by design (see its FAIL-CLOSED CONTRACT
 *   block): when it cannot make a tenant-safe decision it THROWS a typed
 *   `DebouncerRedisUnavailableError` and the caller (`baileys.ts`) stops —
 *   the message stays persisted in Postgres and is swept by
 *   `aggregateUnprocessedTexts` on the next cycle. A Redis OOM is handled the
 *   SAME way (NOT fail-open: silently skipping the debounce could drop the
 *   message or arm a BullMQ job without its companion Redis state):
 *     - a raw ioredis `ReplyError` is converted to
 *       `DebouncerRedisUnavailableError` with `oom === true` (no raw crash),
 *     - `redis_oom_degraded_total{operation="debouncer.write_state"}` (or
 *       `debouncer.clear_state`) increments,
 *     - the error code stays `DEBOUNCER_REDIS_UNAVAILABLE` so baileys.ts
 *       routes it through the existing `redis_unavailable` fail-closed branch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';

const { redisStub, logWarn } = vi.hoisted(() => {
  const makeOom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  let setThrowsOom = false;
  let delThrowsOom = false;
  const stub = {
    makeOom,
    setSetThrowsOom(v: boolean) {
      setThrowsOom = v;
    },
    setDelThrowsOom(v: boolean) {
      delThrowsOom = v;
    },
    get: vi.fn(async () => null),
    set: vi.fn(async () => {
      if (setThrowsOom) throw makeOom();
      return 'OK';
    }),
    del: vi.fn(async () => {
      if (delThrowsOom) throw makeOom();
      return 1;
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
  logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/test',
    REDIS_URL: 'redis://localhost:6379',
    MESSAGE_DEBOUNCE_MS: 5000,
    MESSAGE_DEBOUNCE_MAX_MS: 30000,
  },
}));

const queueAdd = vi.fn(async () => undefined);
const queueGetJob = vi.fn(async () => null as { remove: () => Promise<void> } | null);
vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: queueAdd, getJob: queueGetJob },
}));

const { scheduleDebouncedAgent, clearDebounceState, DebouncerRedisUnavailableError } =
  await import('@/gateway/debouncer.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PHONE = '+5511999999999';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  redisStub.setSetThrowsOom(false);
  redisStub.setDelThrowsOom(false);
  redisStub.get.mockClear();
  redisStub.get.mockResolvedValue(null);
  redisStub.set.mockClear();
  redisStub.del.mockClear();
  queueAdd.mockClear();
  queueGetJob.mockClear();
  queueGetJob.mockResolvedValue(null);
  _resetForTests();
  logWarn.mockClear();
});

describe('debouncer — OOM handling (#309)', () => {
  it('scheduleDebouncedAgent converts a writeState OOM into a typed fail-closed error', async () => {
    // First message path: getJob→null, queue.add→ok, then writeState SET OOMs.
    redisStub.setSetThrowsOom(true);
    await expect(asTenantA(() => scheduleDebouncedAgent({ phone: PHONE, mensagem_id: 'm1' }))).rejects.toMatchObject(
      { code: 'DEBOUNCER_REDIS_UNAVAILABLE', oom: true },
    );
  });

  it('the thrown error is a DebouncerRedisUnavailableError instance (no raw ReplyError)', async () => {
    redisStub.setSetThrowsOom(true);
    await asTenantA(() => scheduleDebouncedAgent({ phone: PHONE, mensagem_id: 'm1' })).catch(
      (err) => {
        expect(err).toBeInstanceOf(DebouncerRedisUnavailableError);
        expect((err as Error).name).toBe('DebouncerRedisUnavailableError');
      },
    );
  });

  it('scheduleDebouncedAgent OOM increments redis_oom_degraded_total{operation="debouncer.write_state"}', async () => {
    redisStub.setSetThrowsOom(true);
    await asTenantA(() => scheduleDebouncedAgent({ phone: PHONE, mensagem_id: 'm1' })).catch(() => {});
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="debouncer.write_state"} 1');
  });

  it('a BullMQ enqueue OOM also converts to the typed fail-closed error + metric', async () => {
    // queue.add itself OOMs (BullMQ write under memory pressure). The outer
    // catch records the capacity signal and converts to the typed error.
    queueAdd.mockImplementationOnce(async () => {
      throw redisStub.makeOom();
    });
    await expect(asTenantA(() => scheduleDebouncedAgent({ phone: PHONE, mensagem_id: 'm1' }))).rejects.toMatchObject(
      { code: 'DEBOUNCER_REDIS_UNAVAILABLE', oom: true },
    );
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="debouncer.write_state"} 1');
  });

  it('clearDebounceState converts a del OOM into the typed fail-closed error + clear_state metric', async () => {
    redisStub.setDelThrowsOom(true);
    await expect(asTenantA(() => clearDebounceState(PHONE))).rejects.toMatchObject({
      code: 'DEBOUNCER_REDIS_UNAVAILABLE',
      oom: true,
    });
    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="debouncer.clear_state"} 1');
  });

  it('a NON-OOM SET error still propagates as-is (not relabelled OOM)', async () => {
    const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
    redisStub.set.mockImplementationOnce(async () => {
      throw boom;
    });
    await expect(asTenantA(() => scheduleDebouncedAgent({ phone: PHONE, mensagem_id: 'm1' }))).rejects.toBe(boom);
    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });
});
