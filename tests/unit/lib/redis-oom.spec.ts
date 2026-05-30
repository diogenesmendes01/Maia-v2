/**
 * Issue #309 — Redis OOM detection + degradation accounting.
 *
 * Covers the shared primitives in `src/lib/redis.ts`:
 *   - `isRedisOomError(err)` — detects an ioredis `ReplyError` whose reply
 *     text begins with the Redis `OOM` error prefix (and, defensively, a
 *     `.code === 'OOM'`), WITHOUT false-positiving on lookalike words.
 *   - `recordRedisOomDegraded(caller, extra)` — increments the low-cardinality
 *     `redis_oom_degraded_total{operation}` counter and logs a structured
 *     `redis.oom_degraded` warning. The metric MUST NOT carry raw
 *     tenant/agent IDs as labels (cardinality discipline, mirrors #286).
 *
 * The metrics assertions run the REAL `incCounter`/`renderPrometheus` so a
 * label-encoding regression (e.g. someone adds `tenant_id` as a label) is
 * caught end-to-end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The real ReplyError class from redis-errors (what ioredis actually throws).
// Importing it proves our detector works against the genuine error shape, not
// just a hand-rolled stub.
import { ReplyError } from 'redis-errors';

const warnMock = vi.fn();
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: (...a: unknown[]) => warnMock(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `src/lib/redis.ts` instantiates an ioredis client at import time. We stub
// `ioredis` so importing the module under test does not open a socket, and
// stub the env config so `config.REDIS_URL` resolves.
vi.mock('ioredis', () => {
  class FakeRedis {
    on() {
      return this;
    }
  }
  return { default: FakeRedis };
});
vi.mock('@/config/env.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));

const { isRedisOomError, recordRedisOomDegraded } = await import('@/lib/redis.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const OOM_MESSAGE = "OOM command not allowed when used memory > 'maxmemory'.";

beforeEach(() => {
  _resetForTests();
  warnMock.mockClear();
});

describe('isRedisOomError (#309)', () => {
  it('detects a genuine ioredis ReplyError with the OOM reply text', () => {
    const err = new ReplyError(OOM_MESSAGE);
    // Sanity: the genuine error names itself ReplyError via a getter.
    expect((err as Error).name).toBe('ReplyError');
    expect(isRedisOomError(err)).toBe(true);
  });

  it('detects a ReplyError-shaped object (name + OOM message)', () => {
    const err = Object.assign(new Error(OOM_MESSAGE), { name: 'ReplyError' });
    expect(isRedisOomError(err)).toBe(true);
  });

  it('detects via a string `.code` of "OOM" (wrapper clients)', () => {
    expect(isRedisOomError({ code: 'OOM', message: 'whatever' })).toBe(true);
    expect(isRedisOomError({ code: 'oom', message: 'whatever' })).toBe(true);
  });

  it('detects an OOM message even if the .name was lost on re-wrap', () => {
    // A re-thrown error may drop `name` but keep the reply text.
    expect(isRedisOomError(new Error(OOM_MESSAGE))).toBe(true);
  });

  it('detects the WRAPPED Lua/EVAL OOM form (leading token is ERR, not OOM) — #333/#339', () => {
    // An OOM raised INSIDE a server-side script (e.g. the atomic working-memory
    // EVAL) is surfaced wrapped: the reply begins with `ERR Error running
    // script …` and embeds the canonical OOM phrase further along. The leading
    // token is `ERR`, so a prefix-anchored check would miss it — the substring
    // branch must catch it (otherwise `pushMessage` rethrows instead of failing
    // open, the exact PR #339 regression).
    const wrapped =
      "ERR Error running script (call to f_0123456789abcdef): @user_script:1: " +
      OOM_MESSAGE;
    // Sanity: it really does NOT start with the OOM token.
    expect(/^\s*OOM\b/i.test(wrapped)).toBe(false);
    expect(isRedisOomError(new ReplyError(wrapped))).toBe(true);
    // Also via the genuine ReplyError shape with the name preserved.
    expect(
      isRedisOomError(Object.assign(new Error(wrapped), { name: 'ReplyError' })),
    ).toBe(true);
  });

  it('is case-insensitive on the OOM token', () => {
    const err = Object.assign(new Error("oom command not allowed"), { name: 'ReplyError' });
    expect(isRedisOomError(err)).toBe(true);
  });

  it('does NOT false-positive on lookalike words ("zoom", "room")', () => {
    expect(isRedisOomError(new Error('zoom level changed'))).toBe(false);
    expect(isRedisOomError(new Error('no room left in the inn'))).toBe(false);
    expect(
      isRedisOomError(Object.assign(new Error('zoomed out'), { name: 'ReplyError' })),
    ).toBe(false);
  });

  it('does NOT match a non-OOM ReplyError (e.g. WRONGTYPE)', () => {
    const err = Object.assign(
      new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      { name: 'ReplyError' },
    );
    expect(isRedisOomError(err)).toBe(false);
  });

  it('does NOT match a generic connection error', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(isRedisOomError(err)).toBe(false);
  });

  it('returns false for null / undefined / non-objects', () => {
    expect(isRedisOomError(null)).toBe(false);
    expect(isRedisOomError(undefined)).toBe(false);
    expect(isRedisOomError('OOM command not allowed')).toBe(false);
    expect(isRedisOomError(42)).toBe(false);
  });
});

describe('recordRedisOomDegraded (#309)', () => {
  it('increments redis_oom_degraded_total labelled by operation', async () => {
    recordRedisOomDegraded('working_memory.push');
    recordRedisOomDegraded('working_memory.push');
    recordRedisOomDegraded('dedup.mark_seen');

    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="working_memory.push"} 2');
    expect(out).toContain('redis_oom_degraded_total{operation="dedup.mark_seen"} 1');
  });

  it('emits a structured redis.oom_degraded warning with redis_oom=true', () => {
    recordRedisOomDegraded('vision_cache.set', { tenant_id: 't1', agent_id: 'a1', tool: 'boleto' });
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [fields, msg] = warnMock.mock.calls[0]!;
    expect(msg).toBe('redis.oom_degraded');
    expect(fields).toMatchObject({
      redis_oom: true,
      caller: 'vision_cache.set',
      tenant_id: 't1',
      agent_id: 'a1',
    });
  });

  it('NEVER puts tenant_id / agent_id on the metric label (cardinality discipline)', async () => {
    recordRedisOomDegraded('bot_detection.incr', {
      tenant_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const out = await renderPrometheus();
    const oomLines = out.split('\n').filter((l) => l.startsWith('redis_oom_degraded_total'));
    expect(oomLines.length).toBeGreaterThan(0);
    for (const line of oomLines) {
      expect(line).not.toMatch(/tenant_id=/);
      expect(line).not.toMatch(/agent_id=/);
      expect(line).not.toContain('11111111-1111-1111-1111-111111111111');
      expect(line).not.toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      // Only the `operation` label is allowed.
      expect(line).toMatch(/^redis_oom_degraded_total\{operation="[^"]+"\} \d+$/);
    }
  });
});
