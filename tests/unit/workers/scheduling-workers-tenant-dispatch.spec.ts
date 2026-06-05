/**
 * Issue #355 — the three scheduling workers are per-tenant DISPATCHERS.
 *
 * Now that every scheduling query scopes by the ALS tenant context, the
 * scheduling_tick / outbox_drain / series_next_scheduler workers MUST run their
 * engine inner inside `runWithTenantContext`. This spec proves, for each worker:
 *
 *   1. It enumerates DISTINCT (tenant_id, agent_id) tuples (schedulingDispatch.*)
 *      and runs the engine inner ONCE PER tuple under that tuple's context.
 *   2. NO `'default'` sentinel — when real tuples exist, the inner never runs
 *      under default/default.
 *   3. Empty enumeration → clean no-op (inner never invoked).
 *   4. Fail-isolated: a throw under tenant-A does not block tenant-B.
 *   5. Not coupled to caller context: an ambient tenant-A does not override the
 *      enumerated tenant-B.
 *
 * Mirrors `tests/unit/workers/audit-mode-expirer-cross-tenant.spec.ts`: mock the
 * dispatch enumeration + the engine inner (which captures the ACTIVE context via
 * `tryGetCurrentContext`) so the assertion is on the SCOPE the worker opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

type Pair = { tenant_id: string; agent_id: string };

// ---- engine inner mocks (capture the context they run under) ---------------
const tickContexts: Pair[] = [];
const seriesContexts: Pair[] = [];
const drainContexts: Pair[] = [];
let throwForTuple = new Set<string>();

function captureCtx(bucket: Pair[]): Pair {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error('scheduling engine inner ran OUTSIDE tenant context — repos would throw in prod');
  }
  bucket.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic failure for ${key}`);
  return ctx;
}

const runSchedulingTickMock = vi.fn(async () => {
  captureCtx(tickContexts);
  return { reclaimed: 0, claimed: 1, advanced: 1, skipped: 0, timed_out: 0, in_progress_advanced: 0 };
});
const runSeriesNextSchedulerMock = vi.fn(async () => {
  captureCtx(seriesContexts);
  return { scheduled: 1 };
});
const runOutboxDrainMock = vi.fn(async () => {
  captureCtx(drainContexts);
  // drained=0 so the per-tenant pass-loop exits after one pass.
  return { reclaimed: 0, drained: 0, sent: 0, failed: 0, rate_limited: 0 };
});

vi.mock('@/scheduling/engine.js', () => ({
  runSchedulingTick: runSchedulingTickMock,
  runSeriesNextScheduler: runSeriesNextSchedulerMock,
}));
vi.mock('@/scheduling/outbox-drain.js', () => ({
  runOutboxDrain: runOutboxDrainMock,
}));

// ---- dispatch enumeration mocks --------------------------------------------
let tickTuples: Pair[] = [];
let seriesTuples: Pair[] = [];
let outboxTuples: Pair[] = [];
const enumerateTickMock = vi.fn(async () => tickTuples);
const enumerateActiveSeriesMock = vi.fn(async () => seriesTuples);
const enumerateOutboxMock = vi.fn(async () => outboxTuples);

vi.mock('@/scheduling/repos.js', () => ({
  schedulingDispatch: {
    enumerateTickTenants: enumerateTickMock,
    enumerateActiveSeriesTenants: enumerateActiveSeriesMock,
    enumerateOutboxTenants: enumerateOutboxMock,
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Only the outbox drain-loop knobs are read from config now (scheduling V2 is
// 100% cutover — #406 removed FEATURE_SCHEDULING_V2).
const cfg = {
  OUTBOX_DRAIN_LOOP_PASSES: 5,
  OUTBOX_DRAIN_LOOP_SLEEP_MS: 0,
};
vi.mock('@/config/env.js', () => ({ config: cfg }));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

beforeEach(() => {
  tickContexts.length = 0;
  seriesContexts.length = 0;
  drainContexts.length = 0;
  throwForTuple = new Set();
  tickTuples = [];
  seriesTuples = [];
  outboxTuples = [];
  runSchedulingTickMock.mockClear();
  runSeriesNextSchedulerMock.mockClear();
  runOutboxDrainMock.mockClear();
  enumerateTickMock.mockClear();
  enumerateActiveSeriesMock.mockClear();
  enumerateOutboxMock.mockClear();
});

describe('scheduling_tick worker — per-tenant dispatcher (#355)', () => {
  it('runs the engine tick once per enumerated tuple under its own context', async () => {
    tickTuples = [A, B];
    const { runScheduling } = await import('@/workers/scheduling-tick.js');
    await runScheduling();
    expect(enumerateTickMock).toHaveBeenCalledTimes(1);
    expect(runSchedulingTickMock).toHaveBeenCalledTimes(2);
    expect(new Set(tickContexts.map((c) => `${c.tenant_id}|${c.agent_id}`))).toEqual(
      new Set(['tenant-A|agent-A', 'tenant-B|agent-B']),
    );
  });

  it('NO default/default leak when real tuples exist', async () => {
    tickTuples = [A, B];
    const { runScheduling } = await import('@/workers/scheduling-tick.js');
    await runScheduling();
    for (const c of tickContexts) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('empty enumeration → no-op (engine never invoked)', async () => {
    tickTuples = [];
    const { runScheduling } = await import('@/workers/scheduling-tick.js');
    await runScheduling();
    expect(runSchedulingTickMock).not.toHaveBeenCalled();
  });

  it('fail-isolated: tenant-A throw does not block tenant-B', async () => {
    tickTuples = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);
    const { runScheduling } = await import('@/workers/scheduling-tick.js');
    await expect(runScheduling()).resolves.toBeUndefined();
    expect(runSchedulingTickMock).toHaveBeenCalledTimes(2);
    expect(tickContexts.some((c) => c.tenant_id === 'tenant-B')).toBe(true);
  });

  it('not coupled to caller context: ambient tenant-A does not override enumerated tenant-B', async () => {
    tickTuples = [B];
    const { runScheduling } = await import('@/workers/scheduling-tick.js');
    await runWithTenantContext(A, runScheduling);
    expect(tickContexts).toEqual([B]);
  });
});

describe('series_next_scheduler worker — per-tenant dispatcher (#355)', () => {
  it('runs the backfill once per enumerated tuple under its own context', async () => {
    seriesTuples = [A, B];
    const { runSeriesNextSchedulerWorker } = await import('@/workers/series-next-scheduler.js');
    await runSeriesNextSchedulerWorker();
    expect(enumerateActiveSeriesMock).toHaveBeenCalledTimes(1);
    expect(runSeriesNextSchedulerMock).toHaveBeenCalledTimes(2);
    expect(new Set(seriesContexts.map((c) => `${c.tenant_id}|${c.agent_id}`))).toEqual(
      new Set(['tenant-A|agent-A', 'tenant-B|agent-B']),
    );
  });

  it('empty enumeration → no-op', async () => {
    seriesTuples = [];
    const { runSeriesNextSchedulerWorker } = await import('@/workers/series-next-scheduler.js');
    await runSeriesNextSchedulerWorker();
    expect(runSeriesNextSchedulerMock).not.toHaveBeenCalled();
  });

  it('fail-isolated: tenant-A throw does not block tenant-B', async () => {
    seriesTuples = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);
    const { runSeriesNextSchedulerWorker } = await import('@/workers/series-next-scheduler.js');
    await expect(runSeriesNextSchedulerWorker()).resolves.toBeUndefined();
    expect(runSeriesNextSchedulerMock).toHaveBeenCalledTimes(2);
  });
});

describe('outbox_drain worker — per-tenant dispatcher (#355)', () => {
  it('runs the drain once per enumerated tuple under its own context', async () => {
    outboxTuples = [A, B];
    const { runOutboxDrainWorker } = await import('@/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(enumerateOutboxMock).toHaveBeenCalledTimes(1);
    // One pass per tenant (drained=0 exits the loop immediately).
    expect(runOutboxDrainMock).toHaveBeenCalledTimes(2);
    expect(new Set(drainContexts.map((c) => `${c.tenant_id}|${c.agent_id}`))).toEqual(
      new Set(['tenant-A|agent-A', 'tenant-B|agent-B']),
    );
  });

  it('NO default/default leak when real tuples exist', async () => {
    outboxTuples = [A, B];
    const { runOutboxDrainWorker } = await import('@/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    for (const c of drainContexts) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('empty enumeration → no-op', async () => {
    outboxTuples = [];
    const { runOutboxDrainWorker } = await import('@/workers/outbox-drain-worker.js');
    await runOutboxDrainWorker();
    expect(runOutboxDrainMock).not.toHaveBeenCalled();
  });

  it('fail-isolated: tenant-A throw does not block tenant-B', async () => {
    outboxTuples = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);
    const { runOutboxDrainWorker } = await import('@/workers/outbox-drain-worker.js');
    await expect(runOutboxDrainWorker()).resolves.toBeUndefined();
    expect(drainContexts.some((c) => c.tenant_id === 'tenant-B')).toBe(true);
  });

  it('not coupled to caller context: ambient tenant-A does not override enumerated tenant-B', async () => {
    outboxTuples = [B];
    const { runOutboxDrainWorker } = await import('@/workers/outbox-drain-worker.js');
    await runWithTenantContext(A, runOutboxDrainWorker);
    expect(drainContexts).toEqual([B]);
  });
});
