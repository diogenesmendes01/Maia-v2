/**
 * Issue #297 — Redis memory pressure collector.
 *
 * Mocks `src/lib/redis.js` so we can drive `info('memory')` /
 * `info('stats')` deterministically, then asserts:
 *  1. INFO output is parsed correctly (used_memory, maxmemory, evicted_keys,
 *     rejected_connections — including the lookalike `used_memory_rss` does
 *     not contaminate the parse).
 *  2. Gauges expose the parsed values via `/metrics` (renderPrometheus).
 *  3. The derived ratio is `used / max` and handles `maxmemory=0`
 *     (Redis "unbounded") as `0`, not `Infinity`/`NaN`.
 *  4. A Redis-down `info()` rejection is caught — the snapshot keeps the
 *     previous values (stale-but-not-zeroed), the collector does not throw,
 *     and a warn is logged.
 *  5. `parseInfoField` handles the substring-boundary edge case
 *     (`used_memory_rss` vs `used_memory`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { infoMock, loggerWarnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../../src/lib/redis.js', () => ({
  redis: { info: infoMock },
  isRedisConnected: () => true,
  ensureRedisConnect: vi.fn(),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  collectOnce,
  parseInfoField,
  startRedisMemoryCollector,
  _resetForTests,
} from '../../../src/observability/redis-memory-collector.js';
import { renderPrometheus, _resetForTests as _resetMetrics } from '../../../src/lib/metrics.js';

const SAMPLE_MEMORY_INFO = [
  '# Memory',
  'used_memory:1610612736', // 1.5 GiB
  'used_memory_human:1.50G',
  'used_memory_rss:1700000000',
  'used_memory_peak:1700000000',
  'maxmemory:2147483648', // 2 GiB
  'maxmemory_human:2.00G',
  'maxmemory_policy:noeviction',
  '',
].join('\r\n');

const SAMPLE_STATS_INFO = [
  '# Stats',
  'total_connections_received:1234',
  'rejected_connections:5',
  'evicted_keys:0',
  'expired_keys:42',
  '',
].join('\r\n');

describe('redis-memory-collector — parseInfoField', () => {
  it('extracts an integer field by exact name', () => {
    expect(parseInfoField(SAMPLE_MEMORY_INFO, 'used_memory')).toBe(1610612736);
    expect(parseInfoField(SAMPLE_MEMORY_INFO, 'maxmemory')).toBe(2147483648);
    expect(parseInfoField(SAMPLE_STATS_INFO, 'evicted_keys')).toBe(0);
    expect(parseInfoField(SAMPLE_STATS_INFO, 'rejected_connections')).toBe(5);
  });

  it('does NOT match a substring of a longer field name', () => {
    // `used_memory_rss:1700000000` must not be returned for `used_memory`.
    // The anchored regex ensures `used_memory` matches only the exact line,
    // returning 1610612736 (not 1700000000).
    expect(parseInfoField(SAMPLE_MEMORY_INFO, 'used_memory')).toBe(1610612736);
  });

  it('returns undefined when the field is absent', () => {
    expect(parseInfoField(SAMPLE_MEMORY_INFO, 'nonexistent_field')).toBeUndefined();
    expect(parseInfoField('', 'used_memory')).toBeUndefined();
  });

  it('returns undefined when the value is non-numeric', () => {
    // Defensive: in practice Redis only emits integers in these slots, but
    // we tolerate junk and surface `undefined` so collectOnce skips the
    // update rather than zeroing the snapshot.
    expect(parseInfoField('used_memory:not_a_number\r\n', 'used_memory')).toBeUndefined();
  });
});

describe('redis-memory-collector — collectOnce + gauges', () => {
  beforeEach(() => {
    _resetMetrics();
    _resetForTests();
    infoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  afterEach(() => {
    _resetMetrics();
    _resetForTests();
  });

  it('parses INFO output and populates gauges (used / max / evicted / rejected)', async () => {
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(SAMPLE_MEMORY_INFO);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });

    // Register gauges via startRedisMemoryCollector but stop the timer
    // immediately so the test owns the lifecycle. startRedisMemoryCollector
    // kicks off an initial collectOnce() via `void collectOnce()` — we await
    // a fresh one below to make sure the snapshot is populated before the
    // scrape, sidestepping the unhandled-microtask race.
    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    const out = await renderPrometheus();
    expect(out).toContain('redis_used_memory_bytes 1610612736');
    expect(out).toContain('redis_maxmemory_bytes 2147483648');
    expect(out).toContain('redis_evicted_keys_total 0');
    expect(out).toContain('redis_rejected_connections_total 5');
  });

  it('derives memory_used_ratio = used / max (1.5GiB / 2GiB = 0.75)', async () => {
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(SAMPLE_MEMORY_INFO);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });

    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    const out = await renderPrometheus();
    // 1610612736 / 2147483648 = 0.75 exactly (both powers of two scaled).
    expect(out).toContain('redis_memory_used_ratio 0.75');
  });

  it('reports ratio=0 when maxmemory is 0 (Redis unbounded — no cap)', async () => {
    const unboundedMemoryInfo = [
      '# Memory',
      'used_memory:1000000',
      'maxmemory:0',
      '',
    ].join('\r\n');
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(unboundedMemoryInfo);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });

    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    const out = await renderPrometheus();
    // With maxmemory=0 the ratio is undefined; we emit 0 so warning/critical
    // alerts on `> 0.80` / `> 0.95` cannot fire spuriously.
    expect(out).toContain('redis_memory_used_ratio 0');
    expect(out).not.toContain('redis_memory_used_ratio Infinity');
    expect(out).not.toContain('redis_memory_used_ratio NaN');
  });

  it('handles Redis-down gracefully — keeps last snapshot, does not throw, logs warn', async () => {
    // 1) Populate the snapshot with a successful first collect.
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(SAMPLE_MEMORY_INFO);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });

    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    // 2) Simulate Redis-down on the next collect. `Promise.all` rejects on
    //    the first reject so we only need one of the two info() calls to
    //    error to exercise the catch path.
    infoMock.mockReset();
    infoMock.mockRejectedValue(new Error('ECONNREFUSED'));

    // Must not throw — collector swallows the error.
    await expect(collectOnce()).resolves.toBeUndefined();

    // Warn was emitted with the error message.
    expect(loggerWarnMock).toHaveBeenCalled();
    const warnArg = loggerWarnMock.mock.calls[0]?.[0];
    expect(warnArg).toMatchObject({ err: 'ECONNREFUSED' });

    // Gauges still reflect the previous successful snapshot — stale, not
    // zeroed. (Going to zero would falsely trigger an "emptied Redis" panic.)
    const out = await renderPrometheus();
    expect(out).toContain('redis_used_memory_bytes 1610612736');
    expect(out).toContain('redis_maxmemory_bytes 2147483648');
  });

  it('reports zeros when no successful collect has ever run', async () => {
    // Cold start: collector never returned a valid INFO. The snapshot is
    // initialized to zeros, which is the right "no observation" semantics
    // for `redis_used_memory_bytes` (it's not lying about Redis being empty
    // — `maia_redis_connected` is the canonical "Redis is up" signal).
    infoMock.mockRejectedValue(new Error('boot — not connected yet'));

    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    const out = await renderPrometheus();
    expect(out).toContain('redis_used_memory_bytes 0');
    expect(out).toContain('redis_maxmemory_bytes 0');
    expect(out).toContain('redis_memory_used_ratio 0');
    expect(out).toContain('redis_evicted_keys_total 0');
    expect(out).toContain('redis_rejected_connections_total 0');
  });

  it('partial INFO response does not zero previously-good fields', async () => {
    // 1) First collect: full snapshot.
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(SAMPLE_MEMORY_INFO);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });
    const handle = startRedisMemoryCollector(60_000);
    handle.stop();
    await collectOnce();

    // 2) Second collect: memory INFO omits `maxmemory` (e.g. truncated reply).
    //    The collector must keep the previous `maxmemory` value rather than
    //    falling back to 0 — otherwise the ratio gauge would jump to 0 and
    //    silently disable the > 0.80 / > 0.95 alerts.
    const truncatedMemoryInfo = [
      '# Memory',
      'used_memory:1700000000', // updated
      '', // no maxmemory line
    ].join('\r\n');
    infoMock.mockReset();
    infoMock.mockImplementation((section: string) => {
      if (section === 'memory') return Promise.resolve(truncatedMemoryInfo);
      if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
      return Promise.resolve('');
    });

    await collectOnce();

    const out = await renderPrometheus();
    expect(out).toContain('redis_used_memory_bytes 1700000000'); // updated
    expect(out).toContain('redis_maxmemory_bytes 2147483648'); // preserved
  });
});

describe('redis-memory-collector — startRedisMemoryCollector lifecycle', () => {
  beforeEach(() => {
    _resetMetrics();
    _resetForTests();
    infoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  afterEach(() => {
    _resetMetrics();
    _resetForTests();
  });

  it('runs collectOnce on a setInterval and stop() halts further collections', async () => {
    vi.useFakeTimers();
    try {
      infoMock.mockImplementation((section: string) => {
        if (section === 'memory') return Promise.resolve(SAMPLE_MEMORY_INFO);
        if (section === 'stats') return Promise.resolve(SAMPLE_STATS_INFO);
        return Promise.resolve('');
      });

      const handle = startRedisMemoryCollector(1000);
      // Flush pending microtasks so the boot-time `void collectOnce()` runs.
      // Each collect performs 2 info() calls (memory + stats) inside
      // Promise.all, so the boot collect alone contributes 2 calls.
      await vi.advanceTimersByTimeAsync(0);
      const callsAfterBoot = infoMock.mock.calls.length;
      // Boot collect must have fired at least once. Fake-timer scheduling
      // semantics can race the initial setInterval tick with the boot
      // collect, so we tolerate either 2 (just boot) or 4 (boot + first
      // interval) — both prove the collector is wired.
      expect(callsAfterBoot).toBeGreaterThanOrEqual(2);
      expect(callsAfterBoot % 2).toBe(0); // always called in pairs

      // Advance time so another interval tick fires; expect at least one
      // more pair beyond the boot count.
      await vi.advanceTimersByTimeAsync(1000);
      expect(infoMock.mock.calls.length).toBeGreaterThanOrEqual(callsAfterBoot + 2);

      handle.stop();
      const callsAfterStop = infoMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      // After stop(), the interval is cleared — no further info() calls.
      expect(infoMock.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is idempotent (safe to call twice)', () => {
    infoMock.mockResolvedValue('');
    const handle = startRedisMemoryCollector(60_000);
    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });
});
