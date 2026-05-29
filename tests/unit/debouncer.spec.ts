import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories run before module imports, so any variables referenced
// inside them must be declared via vi.hoisted (which runs even earlier).
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const fakeRedis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _mode?: string, _ttl?: number) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      const had = store.delete(k);
      return had ? 1 : 0;
    }),
  };
  return {
    store,
    fakeRedis,
    redisConnected: { value: true },
    queueAdd: vi.fn(async () => undefined),
    queueGetJob: vi.fn(
      async (_id: string) => null as { remove: () => Promise<void> } | null,
    ),
  };
});

vi.mock('../../src/lib/redis.js', () => ({
  redis: h.fakeRedis,
  isRedisConnected: () => h.redisConnected.value,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/test',
    REDIS_URL: 'redis://localhost:6379',
    MESSAGE_DEBOUNCE_MS: 5000,
    MESSAGE_DEBOUNCE_MAX_MS: 30000,
  },
}));

vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: {
    add: h.queueAdd,
    getJob: h.queueGetJob,
  },
}));

import {
  scheduleDebouncedAgent,
  clearDebounceState,
  debounceJobId,
  _internal,
} from '../../src/gateway/debouncer.js';
import { runWithTenantContext } from '../../src/db/tenant-context.js';

// Issue #248 — debounce keys are now namespaced by
// `${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}` (PR #259 review,
// adopts URI-encoding pattern from #257/#258). All non-throw tests run
// inside a tenant context; missing-context + Redis-down behaviour has its
// own dedicated spec in `tests/unit/gateway/debouncer-cross-tenant.spec.ts`.
const T = 'default';
const A = 'default';
const PHONE = '+5511999999999';
const enc = encodeURIComponent;
const SCOPED = `${enc(T)}:${enc(A)}:${enc(PHONE)}`;
const withCtx = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

describe('debouncer.scheduleDebouncedAgent', () => {
  beforeEach(() => {
    h.store.clear();
    h.redisConnected.value = true;
    h.queueAdd.mockClear();
    h.queueGetJob.mockClear();
    h.queueGetJob.mockResolvedValue(null);
  });

  it('first message: enqueues delayed job, stamps first_enqueued_at', async () => {
    const before = Date.now();
    const result = await withCtx(() =>
      scheduleDebouncedAgent({
        phone: PHONE,
        mensagem_id: 'm1',
      }),
    );

    expect(result).toMatchObject({ kind: 'scheduled', reset: false });
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = h.queueAdd.mock.calls[0]!;
    expect(name).toBe('process-message-debounced');
    expect(data).toEqual({ mensagem_id: 'm1' });
    expect(opts).toMatchObject({
      jobId: `debounce:${SCOPED}`,
      delay: 5000,
    });

    const stateRaw = h.store.get(_internal.STATE_KEY(SCOPED));
    expect(stateRaw).toBeTruthy();
    const state = JSON.parse(stateRaw!);
    expect(state.first_enqueued_at).toBeGreaterThanOrEqual(before);
  });

  it('second message within window: removes old job, adds new with reset flag, preserves first_enqueued_at', async () => {
    // Stage prior state — pretend M1 was enqueued 1.5s ago.
    const firstAt = Date.now() - 1500;
    h.store.set(
      _internal.STATE_KEY(SCOPED),
      JSON.stringify({ first_enqueued_at: firstAt }),
    );
    const remove = vi.fn(async () => undefined);
    h.queueGetJob.mockResolvedValueOnce({ remove });

    const result = await withCtx(() =>
      scheduleDebouncedAgent({
        phone: PHONE,
        mensagem_id: 'm2',
      }),
    );

    expect(result.kind).toBe('scheduled');
    if (result.kind === 'scheduled') {
      expect(result.reset).toBe(true);
      expect(result.held_ms).toBeGreaterThanOrEqual(1500);
      expect(result.held_ms).toBeLessThan(30000);
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
    expect(h.queueAdd.mock.calls[0]![1]).toEqual({ mensagem_id: 'm2' });

    // first_enqueued_at must NOT advance — that's how max-hold ticks.
    const state = JSON.parse(h.store.get(_internal.STATE_KEY(SCOPED))!);
    expect(state.first_enqueued_at).toBe(firstAt);
  });

  it('past max_hold_ms: leaves existing job alone, returns max_hold_passthrough', async () => {
    const firstAt = Date.now() - 31000; // 31s, > 30s ceiling
    h.store.set(
      _internal.STATE_KEY(SCOPED),
      JSON.stringify({ first_enqueued_at: firstAt }),
    );

    const result = await withCtx(() =>
      scheduleDebouncedAgent({
        phone: PHONE,
        mensagem_id: 'm9',
      }),
    );

    expect(result).toEqual({ kind: 'max_hold_passthrough', reason: 'max_hold_exceeded' });
    expect(h.queueGetJob).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('redis disconnected: throws DebouncerRedisUnavailableError (fail-closed) and emits no queue side-effects', async () => {
    // PR #259 review (MAJOR A): the prior contract was "schedule
    // anyway, state best-effort" — i.e. early-return null from
    // `readState`/`writeState` when Redis was down. That created the
    // exact tenant-scoping bypass the per-key namespace fix was meant
    // to prevent: the `agentQueue.add` succeeded under the namespaced
    // jobId, but the SECOND message under the same tenant lost the
    // debounce reset (no state row to consult). And the caller in
    // `baileys.ts` catches a `throw` and falls through to immediate
    // enqueue — which silently bypassed the debounce window for every
    // message during a Redis blip. Fail-closed: throw a specific error
    // so the caller has to opt into the fallback explicitly.
    h.redisConnected.value = false;

    await expect(
      withCtx(() =>
        scheduleDebouncedAgent({
          phone: PHONE,
          mensagem_id: 'm1',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'DebouncerRedisUnavailableError',
      code: 'DEBOUNCER_REDIS_UNAVAILABLE',
    });

    // No queue side-effect — readState throws BEFORE we touch BullMQ,
    // so a Redis blip cannot leave a job armed without its companion
    // Redis state row (which would break the next message's reset).
    expect(h.queueGetJob).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('redis disconnected during clearDebounceState: throws DebouncerRedisUnavailableError', async () => {
    h.redisConnected.value = false;

    await expect(
      withCtx(() => clearDebounceState(PHONE)),
    ).rejects.toMatchObject({
      name: 'DebouncerRedisUnavailableError',
      code: 'DEBOUNCER_REDIS_UNAVAILABLE',
    });
  });

  it('clearDebounceState removes the redis key', async () => {
    const SHORT = '+55119';
    const SHORT_SCOPED = `${enc(T)}:${enc(A)}:${enc(SHORT)}`;
    h.store.set(_internal.STATE_KEY(SHORT_SCOPED), JSON.stringify({ first_enqueued_at: 1 }));
    await withCtx(() => clearDebounceState(SHORT));
    expect(h.store.has(_internal.STATE_KEY(SHORT_SCOPED))).toBe(false);
  });

  it('debounceJobId is deterministic per phone (under the same tenant context)', async () => {
    const a = await withCtx(async () => debounceJobId('+5511'));
    const b = await withCtx(async () => debounceJobId('+5511'));
    const c = await withCtx(async () => debounceJobId('+5522'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('remove failure (race: job moved to active) is benign — still adds new job', async () => {
    h.store.set(
      _internal.STATE_KEY(SCOPED),
      JSON.stringify({ first_enqueued_at: Date.now() - 1000 }),
    );
    h.queueGetJob.mockResolvedValueOnce({
      remove: vi.fn(async () => {
        throw new Error('job is locked');
      }),
    });

    const result = await withCtx(() =>
      scheduleDebouncedAgent({
        phone: PHONE,
        mensagem_id: 'm2',
      }),
    );

    expect(result.kind).toBe('scheduled');
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
  });
});
