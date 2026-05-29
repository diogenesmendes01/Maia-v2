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
  /** When non-null, lrange returns []. Lets us simulate eviction. */
  evictedKeys: Set<string>;
  rpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<'OK'>;
  expire(key: string, seconds: number): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
};

// vi.mock is hoisted above all imports — referencing a top-level `const stub`
// from inside the factory would race with the hoist. Use `vi.hoisted` so the
// stub is constructed in the same hoist pass as the mock factories.
const { stub } = vi.hoisted(() => {
  const lists = new Map<string, ListEntry[]>();
  const ttls = new Map<string, number>();
  const evictedKeys = new Set<string>();

  const s: RedisStub = {
    lists,
    ttls,
    evictedKeys,
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
      if (evictedKeys.has(key)) return [];
      return (lists.get(key) ?? []).map((e) => e.value);
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

describe('working memory observability (#286)', () => {
  beforeEach(() => {
    stub.lists.clear();
    stub.ttls.clear();
    stub.evictedKeys.clear();
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

    it('a single eviction event counts exactly once, even on repeated reads', async () => {
      // The write-deadline record is consumed on the first miss-with-deadline
      // read. A second read against the same evicted key is a normal cold
      // miss — it should NOT double-count.
      await asTenantA(async () => {
        await pushMessage('conv-once', 'user', 'first');
        stub.evictedKeys.add(workingKey('conv-once'));

        await readRecent('conv-once');
        await readRecent('conv-once');
      });

      const out = await renderPrometheus();
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
        await readRecent('conv-evict-canary');
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
