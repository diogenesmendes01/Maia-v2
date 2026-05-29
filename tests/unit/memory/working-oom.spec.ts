/**
 * Issue #309 — Redis OOM handling for WORKING MEMORY (`pushMessage`).
 *
 * Contract proven here (runbook §4.5 + the working.ts docblock):
 *   Working memory is a CACHE; Postgres is the source of truth (the buffer is
 *   rebuilt from persisted `mensagens` on the next turn). On a Redis OOM under
 *   `noeviction` the write degrades FAIL-OPEN:
 *     - the caller does NOT see a throw (a ReplyError must never crash the
 *       turn that pushes a message),
 *     - `redis_oom_degraded_total{operation="working_memory.push"}` increments,
 *     - NO write-deadline is recorded, so the NEXT read does not mis-report a
 *       TTL miss for a write that never landed.
 *
 * Strategy: an in-memory redis stub whose `rpush` throws a genuine ioredis
 * `ReplyError`. `@/lib/redis.js` is fully mocked (the real module builds an
 * ioredis client at import); `recordRedisOomDegraded` in the mock is backed by
 * the REAL metrics counter + the mocked logger so the assertions are
 * end-to-end. The detector itself is unit-tested in `lib/redis-oom.spec.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';

type ListEntry = { value: string };

const { stub, logWarn } = vi.hoisted(() => {
  const lists = new Map<string, ListEntry[]>();
  const markers = new Map<string, string>();
  let oomOnRpush = false;
  let oomOnMarkerSet = false;
  const oom = () =>
    Object.assign(new Error("OOM command not allowed when used memory > 'maxmemory'."), {
      name: 'ReplyError',
    });
  const s = {
    lists,
    markers,
    // Knob name kept for continuity: it models an OOM at the DATA write. After
    // #333 the data write is a single atomic Lua EVAL whose FIRST command is
    // `rpush`, so an OOM under `noeviction` aborts the whole script at that
    // `rpush` — exactly what this flag now simulates by throwing from `eval`.
    setOomOnRpush(v: boolean) {
      oomOnRpush = v;
    },
    setOomOnMarkerSet(v: boolean) {
      oomOnMarkerSet = v;
    },
    // #333: atomic data write. Mirrors the production Lua (rpush + ltrim(-N,-1) +
    // expire) against the in-memory list. An OOM at the first `rpush` aborts the
    // ENTIRE script — nothing is appended, trimmed, or expired — which is the
    // key atomicity property: the list can never be left without its TTL.
    async eval(_script: string, _numKeys: number, key: string, value: string, maxLen: string) {
      if (oomOnRpush) throw oom(); // script aborts before ANY write lands
      const arr = lists.get(key) ?? [];
      arr.push({ value });
      const n = Number(maxLen);
      if (arr.length > n) arr.splice(0, arr.length - n); // ltrim(-N, -1)
      lists.set(key, arr);
      return 1;
    },
    // #317 marker key write — used by pushMessage AFTER the data write.
    async set(key: string, value: string) {
      if (oomOnMarkerSet) throw oom();
      markers.set(key, value);
      return 'OK';
    },
    async lrange(key: string) {
      return (lists.get(key) ?? []).map((e) => e.value);
    },
    // #317 marker key read — used by readRecent for TTL-miss/collision detection.
    async get(key: string) {
      return markers.get(key) ?? null;
    },
  };
  return { stub: s, logWarn: vi.fn() };
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
  redis: stub,
  isRedisConnected: () => true,
  isRedisOomError: detectOom,
  recordRedisOomDegraded: (caller: string, extra?: Record<string, unknown>) => {
    incCounter('redis_oom_degraded_total', { operation: caller });
    logWarn({ redis_oom: true, caller, ...extra }, 'redis.oom_degraded');
  },
}));

const { pushMessage, readRecent, _resetWriteDeadlinesForTests } = await import(
  '@/memory/working.js'
);
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

beforeEach(() => {
  stub.lists.clear();
  stub.markers.clear();
  stub.setOomOnRpush(false);
  stub.setOomOnMarkerSet(false);
  _resetForTests();
  _resetWriteDeadlinesForTests();
  logWarn.mockClear();
});

describe('working memory — OOM degradation (#309)', () => {
  it('does NOT throw to the caller when rpush hits an OOM ReplyError', async () => {
    stub.setOomOnRpush(true);
    await expect(asTenantA(() => pushMessage('conv-1', 'user', 'olá'))).resolves.toBeUndefined();
  });

  it('increments redis_oom_degraded_total{operation="working_memory.push"}', async () => {
    stub.setOomOnRpush(true);
    await asTenantA(() => pushMessage('conv-1', 'user', 'olá'));

    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="working_memory.push"} 1');
  });

  it('emits a structured redis.oom_degraded warning (tenant attribution in log, not metric)', async () => {
    stub.setOomOnRpush(true);
    await asTenantA(() => pushMessage('conv-1', 'user', 'olá'));
    const call = logWarn.mock.calls.find((c) => c[1] === 'redis.oom_degraded');
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      redis_oom: true,
      caller: 'working_memory.push',
      tenant_id: TENANT_A,
      agent_id: AGENT_A,
    });
  });

  it('does NOT write the TTL/collision marker on data OOM → next read is a cold miss, not a TTL miss', async () => {
    stub.setOomOnRpush(true);
    await asTenantA(async () => {
      await pushMessage('conv-evict', 'user', 'gone'); // OOM on rpush → skipped, no marker
      // Now read: lrange returns [] (nothing written) and the marker GET also
      // returns null, so this is a cold read — NOT a TTL miss.
      await readRecent('conv-evict');
    });

    expect(stub.markers.size).toBe(0); // marker never written on the OOM path
    const out = await renderPrometheus();
    // A TTL miss only fires when a live marker coexists with an empty buffer.
    // Since the OOM write skipped the marker, the empty read is a cold miss.
    expect(out).not.toContain('working_memory_ttl_miss_total');
  });

  it('degrades when the data write SUCCEEDS but the #317 marker SET hits OOM (buffer still readable)', async () => {
    // Data lands; only the observability marker OOMs. pushMessage records the
    // OOM degradation and returns without throwing; the buffer is intact.
    stub.setOomOnMarkerSet(true);
    await expect(
      asTenantA(() => pushMessage('conv-marker', 'user', 'oi')),
    ).resolves.toBeUndefined();

    const items = await asTenantA(() => readRecent('conv-marker'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: 'user', text: 'oi' });

    const out = await renderPrometheus();
    expect(out).toContain('redis_oom_degraded_total{operation="working_memory.push"} 1');
    // The generic redis-error counter must NOT also fire for the same OOM event.
    expect(out).not.toContain('working_memory_redis_error_total');
  });

  it('a NON-OOM data-write (EVAL) error still propagates (we only absorb OOM)', async () => {
    // #333: the atomic data write is a Lua EVAL. A non-OOM script error (e.g. a
    // WRONGTYPE surfaced by `redis.call` inside the script) must propagate to
    // the caller unchanged — we only absorb the OOM capacity signal.
    const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
    const original = stub.eval;
    (stub as { eval: unknown }).eval = async () => {
      throw boom;
    };
    await expect(asTenantA(() => pushMessage('conv-x', 'user', 'hi'))).rejects.toBe(boom);
    (stub as { eval: unknown }).eval = original;

    const out = await renderPrometheus();
    expect(out).not.toContain('redis_oom_degraded_total');
  });

  it('a NON-OOM marker SET error records the generic redis-error counter, not OOM (and does not throw)', async () => {
    const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
    const original = stub.set;
    (stub as { set: unknown }).set = async () => {
      throw boom;
    };
    await expect(
      asTenantA(() => pushMessage('conv-marker-nonoom', 'user', 'hi')),
    ).resolves.toBeUndefined();
    (stub as { set: unknown }).set = original;

    const out = await renderPrometheus();
    expect(out).toContain('working_memory_redis_error_total{key_type="messages",op="set"} 1');
    expect(out).not.toContain('redis_oom_degraded_total');
  });
});
