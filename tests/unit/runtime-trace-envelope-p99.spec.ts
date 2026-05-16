import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P10b — Envelope sync latency audit gate.
 *
 * The plan: envelope p99 < 20ms (audit gate). DB INSERT itself is mocked
 * to ~1ms (Postgres equivalent on a warm pool); this test measures the
 * CPU overhead of canonical JSON encoding + HMAC + Drizzle row build,
 * which is what we control. Under load, DB write dominates — but our
 * pure-CPU portion must stay well under the budget.
 *
 * Sample size: 200 invocations. p99 is the 198th element (0-indexed) of
 * sorted latencies. Budget: 20ms with a 5ms slop for CI jitter.
 *
 * If this test starts failing, profile canonicalJson + signHmac before
 * anything else — those are the hot spots.
 */
const { dbInsertMock } = vi.hoisted(() => ({ dbInsertMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { insert: () => ({ values: dbInsertMock }) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/metrics.js', () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
}));

import { writeEnvelope } from '../../src/control-plane/runtime-trace/envelope-writer.js';
import { _resetHmacCacheForTests } from '../../src/control-plane/runtime-trace/lib/hmac.js';
import type { TraceEnvelopeInput } from '../../src/control-plane/runtime-trace/types.js';

const baseInput = (i: number): TraceEnvelopeInput => ({
  trace_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  tenant_id: 'tenant-a',
  agent_id: 'agent-1',
  conversa_id: '11111111-1111-1111-1111-111111111111',
  turno_id: '22222222-2222-2222-2222-222222222222',
  decision: {
    decision: 'allow',
    side_effect_level: 'medium',
    policy_id: '33333333-3333-3333-3333-333333333333',
  },
});

describe('writeEnvelope p99 < 20ms (audit gate)', () => {
  beforeEach(() => {
    dbInsertMock.mockReset();
    // Mocked DB write: synchronous resolve (~0ms). Real prod is a few ms over
    // a warm pool; the gate's headroom (20ms) covers that with margin.
    dbInsertMock.mockResolvedValue(undefined);
    _resetHmacCacheForTests();
  });

  it('p99 of pure-CPU latency under 20ms over 200 calls', async () => {
    const N = 200;
    const latencies: number[] = [];
    // Warm up the HMAC cache so the first call doesn't skew p99.
    await writeEnvelope(baseInput(0));
    for (let i = 1; i < N; i++) {
      const out = await writeEnvelope(baseInput(i));
      latencies.push(out.sync_latency_ms);
    }
    latencies.sort((a, b) => a - b);
    const p99Idx = Math.floor(latencies.length * 0.99);
    const p99 = latencies[p99Idx]!;
    expect(p99).toBeLessThan(20);
  });
});
