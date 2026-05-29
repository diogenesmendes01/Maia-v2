/**
 * Issue #286 — Observability for working memory.
 *
 * Surfaces three signals so operators can validate the tenant-scope migration
 * (PR #241) and detect Redis-level regressions:
 *
 *   - working_memory_read_latency_ms{key_type, hit}  (histogram)
 *   - working_memory_ttl_miss_total{key_type}        (counter)
 *   - working_memory_legacy_read_total{key_type}     (counter — vestigial
 *     after #241 removed the legacy fallback; preserved as a 0-emit safety
 *     counter so any future re-introduction of the legacy key shape shows up
 *     on existing dashboards)
 *
 * Cardinality is intentionally low: only `key_type` (closed set: "messages",
 * "rate") and `hit` ("0"|"1") appear as labels. Raw `tenant_id` is NOT a
 * label — per the issue, that would explode label cardinality on a hot path.
 * Per-tenant attribution flows through the structured log instead.
 *
 * These tests run the real `incCounter`/`observeHistogram` against the real
 * `renderPrometheus()` so we catch label-encoding regressions end-to-end.
 *
 * Tenant context (post-#241): every `pushMessage`/`readRecent` call now
 * MUST run inside `runWithTenantContext` because the production code
 * resolves the Redis key from the AsyncLocalStorage tenant context BEFORE
 * the `isRedisConnected()` check. Without a context the function throws
 * `MissingTenantContextError` (loud-fail invariant). The observability
 * surface is otherwise unaffected — the metrics we assert on are emitted
 * after the tenant-scoped key is in hand.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type ListEntry = { value: string };

type RedisStub = {
  lists: Map<string, ListEntry[]>;
  ttls: Map<string, number>;
  /** String keys (the `nx_ttl:` TTL/collision markers — #317). */
  strings: Map<string, string>;
  /** When non-null, lrange returns []. Lets us simulate eviction. */
  evictedKeys: Set<string>;
  /** When a marker key is here, GET returns null — simulates marker eviction. */
  evictedMarkers: Set<string>;
  /** When a key is here, lrange THROWS — simulates a Redis read failure (#317 B1). */
  failLrange: Set<string>;
  rpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<'OK'>;
  expire(key: string, seconds: number): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  set(key: string, value: string, ...args: unknown[]): Promise<'OK'>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
};

// vi.mock is hoisted above all imports — referencing a top-level `const stub`
// from inside the factory would race with the hoist. Use `vi.hoisted` so the
// stub is constructed in the same hoist pass as the mock factories.
const { stub } = vi.hoisted(() => {
  const lists = new Map<string, ListEntry[]>();
  const ttls = new Map<string, number>();
  const strings = new Map<string, string>();
  const evictedKeys = new Set<string>();
  const evictedMarkers = new Set<string>();
  const failLrange = new Set<string>();

  const s: RedisStub = {
    lists,
    ttls,
    strings,
    evictedKeys,
    evictedMarkers,
    failLrange,
    async rpush(key, value) {
      const arr = lists.get(key) ?? [];
      arr.push({ value });
      lists.set(key, arr);
      return arr.length;
    },
    async ltrim(_key, _start, _stop) {
      return 'OK';
    },
    async expire(key, seconds) {
      ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    async lrange(key, _start, _stop) {
      if (failLrange.has(key)) {
        throw new Error(`redis lrange failed (simulated): ${key}`);
      }
      if (evictedKeys.has(key)) return [];
      return (lists.get(key) ?? []).map((e) => e.value);
    },
    // ioredis `set(key, value, 'EX', n)` — we ignore the option args and just
    // store the value so the marker fingerprint round-trips through `get`.
    async set(key, value, ..._args) {
      strings.set(key, value);
      return 'OK';
    },
    async get(key) {
      if (evictedMarkers.has(key)) return null;
      return strings.get(key) ?? null;
    },
    async del(key) {
      const had = strings.delete(key);
      return had ? 1 : 0;
    },
  };
  return { stub: s };
});

vi.mock('@/lib/redis.js', () => ({
  redis: stub,
  isRedisConnected: () => true,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  pushMessage,
  readRecent,
  recordLegacyRead,
  _resetWriteDeadlinesForTests,
} = await import('@/memory/working.js');
const { _resetForTests, renderPrometheus } = await import('@/lib/metrics.js');

// Stable tenant/agent IDs for the spec. Real UUIDs (not "tenant-1") so the
// expected Redis key strings match the production format byte-for-byte.
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(
    { tenant_id: TENANT_A, agent_id: AGENT_A },
    fn,
  );
}

function workingKey(conversa_id: string): string {
  return `working:${TENANT_A}:${AGENT_A}:conv:${conversa_id}:messages`;
}

function markerKey(conversa_id: string): string {
  return `nx_ttl:${TENANT_A}:${AGENT_A}:conv:${conversa_id}:messages`;
}

describe('working memory observability (#286)', () => {
  beforeEach(() => {
    stub.lists.clear();
    stub.ttls.clear();
    stub.strings.clear();
    stub.evictedKeys.clear();
    stub.evictedMarkers.clear();
    stub.failLrange.clear();
    _resetForTests();
    _resetWriteDeadlinesForTests();
  });

  describe('read_latency_ms histogram', () => {
    it('read hit emits latency with hit="1"', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-1', 'user', 'olá');
        await readRecent('conv-1');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="1",key_type="messages"} 1',
      );
      // The sum is observed in milliseconds and is non-negative.
      expect(out).toMatch(
        /working_memory_read_latency_ms_sum\{hit="1",key_type="messages"\} \d+/,
      );
    });

    it('read miss emits latency with hit="0"', async () => {
      // No prior pushMessage — empty list, miss path.
      await asTenantA(async () => {
        await readRecent('conv-empty');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="0",key_type="messages"} 1',
      );
      // The bucket layout must include +Inf for the hit="0" series too.
      expect(out).toContain(
        'working_memory_read_latency_ms_bucket{hit="0",key_type="messages",le="+Inf"} 1',
      );
    });

    it('hit and miss series are independent — labels do not collapse', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-hit', 'user', 'oi');
        await readRecent('conv-hit'); // hit
        await readRecent('conv-miss'); // miss
        await readRecent('conv-miss'); // miss
        await readRecent('conv-miss'); // miss
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="1",key_type="messages"} 1',
      );
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="0",key_type="messages"} 3',
      );
    });
  });

  describe('ttl_miss_total counter', () => {
    it('write + immediate read returning null increments the counter', async () => {
      await asTenantA(async () => {
        // Write succeeds…
        await pushMessage('conv-evicted', 'user', 'hello');
        // …but the entry is "evicted" before the read lands (simulated).
        // The eviction key must match the production-scoped key shape,
        // which after #241 includes tenant_id + agent_id.
        stub.evictedKeys.add(workingKey('conv-evicted'));

        await readRecent('conv-evicted');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_ttl_miss_total{key_type="messages"} 1',
      );
    });

    it('read miss WITHOUT a prior write does NOT count as a TTL miss', async () => {
      // No pushMessage call → readRecent on an absent conv. This is a normal
      // cold-cache read, not an eviction. We assert the metric is absent.
      await asTenantA(async () => {
        await readRecent('conv-cold');
      });

      const out = await renderPrometheus();
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
      // The latency histogram still fires (hit="0").
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="0",key_type="messages"} 1',
      );
    });

    it('successful read after a write does NOT count as a TTL miss', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-ok', 'user', 'hi');
        await readRecent('conv-ok'); // hit, no miss
      });

      const out = await renderPrometheus();
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
    });

    it('a still-evicted key re-counts on each empty read while its marker is alive (#317 B3)', async () => {
      // Semantics CHANGE from #304: the Redis-backed TTL marker is intentionally
      // NOT consumed/deleted on a miss (so a post-hit eviction stays observable
      // until natural expiry/overwrite — B3). Each empty read against a key whose
      // marker is still alive is a genuine "cache miss with a live TTL marker"
      // event (a real reconstruct-from-Postgres), so it counts each time. Alerts
      // window this via `increase(...[5m])`, so per-read counting is correct.
      await asTenantA(async () => {
        await pushMessage('conv-once', 'user', 'first');
        stub.evictedKeys.add(workingKey('conv-once')); // marker survives — only the list is gone

        await readRecent('conv-once');
        await readRecent('conv-once');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_ttl_miss_total{key_type="messages"} 2',
      );
    });

    it('marker natural-expiry: empty read with NO live marker is NOT a miss (#317 N1)', async () => {
      // The marker shares the data TTL. Once it expires (simulated by evicting
      // the marker too), an empty read is indistinguishable from a cold read —
      // it must NOT count as a TTL miss. This is also what bounds memory: there
      // is no in-process map to leak, Redis ages the marker out (N1).
      await asTenantA(async () => {
        await pushMessage('conv-expired', 'user', 'gone');
        stub.evictedKeys.add(workingKey('conv-expired'));
        stub.evictedMarkers.add(markerKey('conv-expired')); // marker TTL elapsed

        await readRecent('conv-expired');
      });

      const out = await renderPrometheus();
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
    });

    it('push→hit→evict→miss is visible: the marker survives a hit (#317 B3)', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-lifecycle', 'user', 'alive');
        await readRecent('conv-lifecycle'); // HIT — marker must NOT be deleted here
        // Eviction happens AFTER the hit but BEFORE the 24h TTL.
        stub.evictedKeys.add(workingKey('conv-lifecycle'));
        await readRecent('conv-lifecycle'); // MISS — only detectable if marker survived the hit
      });

      const out = await renderPrometheus();
      // Exactly one miss (one read after the eviction). If a successful read had
      // deleted the marker (the #304 bug this fixes), the post-hit eviction would
      // be invisible and this would be absent.
      expect(out).toContain(
        'working_memory_ttl_miss_total{key_type="messages"} 1',
      );
      expect(out).toContain(
        'working_memory_read_latency_ms_count{hit="1",key_type="messages"} 1',
      );
    });
  });

  describe('redis_error_total counter (#317 B1)', () => {
    it('a failing lrange records a redis error and does NOT count as a TTL miss', async () => {
      await asTenantA(async () => {
        // Write succeeds (so a live marker exists), then the READ throws.
        await pushMessage('conv-redis-down', 'user', 'hello');
        stub.failLrange.add(workingKey('conv-redis-down'));

        // The Redis failure propagates — readRecent rethrows it.
        await expect(readRecent('conv-redis-down')).rejects.toThrow(
          /redis lrange failed/,
        );
      });

      const out = await renderPrometheus();
      // Recorded under the SEPARATE error metric…
      expect(out).toContain(
        'working_memory_redis_error_total{key_type="messages",op="lrange"} 1',
      );
      // …and NOT folded into the TTL-miss counter (the #304 finally-block bug).
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
      // No latency sample either — a thrown read has no meaningful hit/miss.
      expect(out).not.toContain('working_memory_read_latency_ms_count');
    });
  });

  describe('key_collision_total counter (#317 B2 — core #286 ask)', () => {
    it('same physical key, DIFFERENT scope fingerprint → collision, not a miss', async () => {
      // Simulate a key collision: a marker exists for the production-scoped key
      // but carries a fingerprint from a DIFFERENT logical scope (a missing-
      // prefix legacy path, a truncated hash, or a future ID-gen change). The
      // data list is non-empty (a foreign write), so this is a same-key/
      // different-payload collision.
      await asTenantA(async () => {
        // Seed a foreign payload + a marker whose value is NOT our fingerprint.
        await stub.rpush(workingKey('conv-collision'), JSON.stringify({ role: 'user', text: 'foreign' }));
        await stub.set(markerKey('conv-collision'), 'fingerprint-from-another-scope');

        await readRecent('conv-collision');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_key_collision_total{key_type="messages"} 1',
      );
      // A collision is explained by the foreign scope, so it must NOT also be
      // counted as a TTL miss even when the (foreign) read is empty.
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
    });

    it('a normal write→read round-trip does NOT trip the collision counter', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-no-collision', 'user', 'mine');
        await readRecent('conv-no-collision'); // marker fingerprint matches
      });

      const out = await renderPrometheus();
      expect(out).not.toContain('working_memory_key_collision_total');
    });

    it('an empty read with a foreign-scope marker is a collision, not a TTL miss', async () => {
      await asTenantA(async () => {
        // Marker present (foreign fingerprint) but the list is empty/evicted.
        await stub.set(markerKey('conv-collision-empty'), 'foreign-scope-fingerprint');
        await readRecent('conv-collision-empty');
      });

      const out = await renderPrometheus();
      expect(out).toContain(
        'working_memory_key_collision_total{key_type="messages"} 1',
      );
      expect(out).not.toContain(
        'working_memory_ttl_miss_total{key_type="messages"}',
      );
    });
  });

  describe('multi-worker / restart safety (#317 B4)', () => {
    it('a read on a "second worker" detects the miss via the shared Redis marker', async () => {
      // The marker lives in Redis (shared across workers/restarts), NOT in a
      // process-local Map. We model worker-A writing and worker-B reading by
      // calling _resetWriteDeadlinesForTests() between the two (it is now a
      // no-op, but it asserts no in-process state carries the signal). The miss
      // is still detected because the marker is in the shared Redis stub.
      await asTenantA(async () => {
        await pushMessage('conv-cross-worker', 'user', 'written on worker A');
      });

      // Simulate the worker boundary / restart: drop any in-process state.
      _resetWriteDeadlinesForTests();
      // The data list is evicted between workers, but the Redis marker persists.
      stub.evictedKeys.add(workingKey('conv-cross-worker'));

      await asTenantA(async () => {
        await readRecent('conv-cross-worker'); // "worker B" read
      });

      const out = await renderPrometheus();
      // Detection survived the (simulated) worker boundary purely via Redis.
      expect(out).toContain(
        'working_memory_ttl_miss_total{key_type="messages"} 1',
      );
    });
  });

  describe('legacy_read_total counter', () => {
    // After #241 (v3 Option A) removed the legacy fallback, no production
    // caller invokes `recordLegacyRead`. These tests prove the counter is
    // still wired up correctly so the safety net remains intact: any future
    // re-introduction of a non-tenant-scoped read path can call
    // `recordLegacyRead(...)` and the existing dashboards will pick it up.

    it('recordLegacyRead("messages") increments with the messages key_type', () => {
      recordLegacyRead('messages');

      return renderPrometheus().then((out) => {
        expect(out).toContain(
          'working_memory_legacy_read_total{key_type="messages"} 1',
        );
      });
    });

    it('recordLegacyRead("rate") increments under the rate key_type independently', () => {
      recordLegacyRead('rate');
      recordLegacyRead('rate');
      recordLegacyRead('messages');

      return renderPrometheus().then((out) => {
        expect(out).toContain(
          'working_memory_legacy_read_total{key_type="rate"} 2',
        );
        expect(out).toContain(
          'working_memory_legacy_read_total{key_type="messages"} 1',
        );
      });
    });

    it('no caller invokes legacy by default — counter absent in steady-state reads', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-steady', 'user', 'hi');
        await readRecent('conv-steady');
      });

      const out = await renderPrometheus();
      // Steady-state must not emit a legacy-read sample. After #241 there
      // are zero callers in production; operators rely on this remaining at
      // 0 as proof the tenant-scoped path is the only read path.
      expect(out).not.toContain('working_memory_legacy_read_total');
    });
  });

  describe('cardinality discipline', () => {
    it('does NOT label any metric with a raw tenant_id / agent_id / conversa_id', async () => {
      await asTenantA(async () => {
        await pushMessage('conv-cardinality-canary', 'user', 'hello');
        await readRecent('conv-cardinality-canary');
        stub.evictedKeys.add(workingKey('conv-evict-canary'));
        await pushMessage('conv-evict-canary', 'user', 'gone');
        await readRecent('conv-evict-canary'); // TTL miss
        // Exercise the collision metric (#317 B2) so the canary covers it too.
        await stub.set(markerKey('conv-collision-canary'), 'foreign-scope-fp');
        await readRecent('conv-collision-canary');
        // Exercise the redis-error metric (#317 B1) so the `op` label is covered.
        await pushMessage('conv-err-canary', 'user', 'boom');
        stub.failLrange.add(workingKey('conv-err-canary'));
        await readRecent('conv-err-canary').catch(() => undefined);
      });
      recordLegacyRead('messages');

      const out = await renderPrometheus();
      // Defense-in-depth assertion: if anyone ever adds a `tenant_id="..."` /
      // `conversa_id="..."` label to one of these metrics by accident, this
      // catches it before it ships and explodes Prometheus.
      const workingMemoryLines = out
        .split('\n')
        .filter((l) => l.startsWith('working_memory_'));
      expect(workingMemoryLines.length).toBeGreaterThan(0);
      for (const line of workingMemoryLines) {
        expect(line).not.toMatch(/tenant_id=/);
        expect(line).not.toMatch(/agent_id=/);
        expect(line).not.toMatch(/conversa_id=/);
        // Bonus: also ensure the raw IDs never appear as VALUES on the line
        // (e.g. someone labels with a different key but the value still
        // contains the UUID). Catches accidental leakage in metric names too.
        expect(line).not.toContain(TENANT_A);
        expect(line).not.toContain(AGENT_A);
      }
    });
  });
});
