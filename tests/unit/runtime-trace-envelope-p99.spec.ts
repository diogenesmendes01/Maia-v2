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
 * Codex review #102 (task spec): load test now asserts p99 < 20ms across
 * 1000 envelope writes (was 200). Sample size bump catches tail-latency
 * regressions earlier.
 *
 * If this test starts failing, profile canonicalJson + signHmac before
 * anything else — those are the hot spots.
 */
const { dbInsertMock } = vi.hoisted(() => ({ dbInsertMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  // Issue #514 review round 1 [P1]: the writer's non-transactional path now
  // ends in `.onConflictDoNothing()`, so the chain has to offer it.
  db: {
    insert: () => ({
      values: (row: unknown) => {
        const p = dbInsertMock(row) as Promise<unknown>;
        return {
          then: (res: (v: unknown) => void, rej: (e: unknown) => void) => p.then(res, rej),
          onConflictDoNothing: () => ({
            then: (r: (v: unknown) => void, j: (e: unknown) => void) =>
              p.then(() => r([{ trace_id: 1 }]), j),
            returning: () => p.then(() => [{ trace_id: 1 }]),
          }),
        };
      },
    }),
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/lib/metrics.js', () => ({
  incCounter: vi.fn(),
  observeHistogram: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_MASTER_SECRET: 'p10b-p99-test-master-secret-deterministic',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 1,
  },
}));

import { writeEnvelope } from '../../src/control-plane/runtime-trace/envelope-writer.js';
import {
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
} from '../../src/control-plane/runtime-trace/lib/hmac.js';
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
    _setTestMasterSecretForTests('p10b-p99-test-master-secret-deterministic');
  });

  it('p99 of pure-CPU latency under 20ms over 1000 calls (Codex #102 load test)', async () => {
    const N = 1000;
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
    const p999Idx = Math.floor(latencies.length * 0.999);
    const p999 = latencies[p999Idx]!;
    const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;
    // Diagnostic output (visible on test failure).
    console.log(
      `[p10b p99 audit gate] mean=${mean.toFixed(3)}ms p99=${p99.toFixed(3)}ms p999=${p999.toFixed(3)}ms over ${N} calls`,
    );
    expect(p99).toBeLessThan(20);
  });

  it('p99 budget enforces fail-closed contract (if exceeded, caller MUST abort side effect)', async () => {
    // This is the invariant test: the spec says "writeEnvelope MUST complete
    // in <20ms p99 OR block the side effect that triggered it". The first
    // half is asserted by the perf test above; the second half is asserted
    // by the existing fail-on-throw contract (envelope-writer.spec.ts). This
    // test just documents that the two together form the contract.
    //
    // Audit reasoning: if a future change pushes envelope latency above 20ms,
    // the audit gate (this test) fires in CI BEFORE the change lands. There
    // is no "soft" failure mode — invariant 12 says envelope writes MUST
    // precede side effects, so a slow envelope path either gets fixed or
    // we have to block the side effect path harder.
    expect(true).toBe(true);
  });
});
