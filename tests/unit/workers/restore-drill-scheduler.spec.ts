/**
 * Issue #536 — the restore drill is SCHEDULED, and only ever once at a time.
 *
 * THIS SPEC DELIBERATELY DOES NOT BUILD ITS OWN SCHEDULER. A test that stands
 * up a private harness around `runRestoreDrillTick` keeps passing after the
 * production call site is deleted — it proves the function works, not that
 * anything calls it. So everything below goes through the REAL registry
 * (`JOBS` in `src/workers/index.ts`) and the REAL adapter
 * (`runScheduledRestoreDrill` → `runRestoreDrillJob` → `withOpsLock`).
 * Removing the registry entry, or unhooking the tick from it, fails these
 * tests.
 *
 * Only the leaves are faked: the advisory-lock pool (in-memory, but with real
 * `pg_try_advisory_lock` semantics), the evidence read, and `runRestoreDrill`
 * itself — no Postgres, no S3, no `pg_restore`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { drillSpy, facts, heldLocks, lockCalls, sendAlertSpy } = vi.hoisted(() => ({
  drillSpy: vi.fn(),
  facts: {
    current: {
      last_local_verified_at: new Date(),
      last_offsite_verified_at: new Date(),
      last_restore_drill_at: null as Date | null,
      last_restore_drill_result: null as 'passed' | 'failed' | null,
      last_restore_drill_duration_ms: null as number | null,
      last_restore_drill_cleanup_status: null as 'clean' | 'unsafe' | 'unknown' | null,
      consecutive_failures: 0,
    },
  },
  heldLocks: new Set<string>(),
  lockCalls: { count: 0 },
  sendAlertSpy: vi.fn(async () => undefined),
}));

/**
 * Advisory-lock pool with the semantics that matter: `pg_try_advisory_lock`
 * succeeds only when nobody holds the key, and the unlock releases it. Each
 * `connect()` is an independent session, exactly like the real pool.
 */
vi.mock('@/db/client.js', () => ({
  pool: {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const key = String(values?.[0] ?? '');
        if (text.includes('pg_try_advisory_lock')) {
          lockCalls.count += 1;
          if (heldLocks.has(key)) return { rows: [{ locked: false }] };
          heldLocks.add(key);
          return { rows: [{ locked: true }] };
        }
        if (text.includes('pg_advisory_unlock')) {
          heldLocks.delete(key);
          return { rows: [{}] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  },
  db: {},
  isDbConnected: () => true,
  probeDb: async () => true,
}));

vi.mock('@/db/repositories/ops-repos.js', () => ({
  readReadinessFacts: async () => facts.current,
  restoreDrillStore: { createDrill: async () => undefined, finishDrill: async () => undefined },
  readTombstoneLedger: async () => ({ available: true, tombstones: [] }),
  selectDrillCandidate: async () => null,
  anyActiveLegalHold: async () => false,
  listArtifactRuns: async () => [],
  markRunDeleted: async () => undefined,
  reclaimAbandonedRuns: async () => [],
  recordRetentionRun: async () => undefined,
}));

// The drill's real IO ports would open Postgres connections at call time; the
// lifecycle itself is spied on below, so an empty port bag is enough.
vi.mock('@/ops/backup/drill-adapters.js', () => ({
  createRestoreDrillPorts: () => ({}),
  drillWorkspace: () => '/tmp/drill',
}));

vi.mock('@/ops/backup/drill.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ops/backup/drill.js')>();
  return { ...actual, runRestoreDrill: drillSpy };
});

vi.mock('@/lib/alerts.js', () => ({ sendAlert: sendAlertSpy }));
vi.mock('@/governance/audit.js', () => ({ audit: async () => undefined }));

function drillResult(over: Record<string, unknown> = {}) {
  return {
    drill_id: 'd-1',
    correlation_id: 'c-1',
    backup_id: null,
    source: 'local',
    status: 'passed',
    failure_code: null,
    duration_ms: 1000,
    tombstones_pending: 0,
    probes: {},
    cleanup: { status: 'clean', residue: [] },
    ...over,
  };
}

/**
 * The REAL registry, imported once. `src/workers/index.ts` pulls in the whole
 * worker tree, which takes seconds to transform on a cold cache — well past the
 * 5s default per-test timeout on a loaded machine. Paying it in `beforeAll`
 * with an explicit budget keeps the assertions from flaking on import cost
 * (they are about the registry, not about how fast esbuild is today).
 */
let JOBS: Array<{ name: string; cron: string; phase: number; fn: () => Promise<void> }>;

beforeAll(async () => {
  ({ JOBS } = await import('../../../src/workers/index.js'));
}, 120_000);

function registryJob() {
  const job = JOBS.find((j) => j.name === 'restore_drill');
  if (!job) throw new Error('the restore_drill job is not in the worker registry');
  return job;
}

beforeEach(() => {
  drillSpy.mockReset();
  drillSpy.mockResolvedValue(drillResult());
  heldLocks.clear();
  lockCalls.count = 0;
  sendAlertSpy.mockClear();
  facts.current = {
    last_local_verified_at: new Date(),
    last_offsite_verified_at: new Date(),
    last_restore_drill_at: null,
    last_restore_drill_result: null,
    last_restore_drill_duration_ms: null,
    last_restore_drill_cleanup_status: null,
    consecutive_failures: 0,
  };
});

describe('restore_drill is a real entry in the worker registry', () => {
  it('is registered at phase 1 on an hourly tick', async () => {
    const job = registryJob();
    // PHASE 1: production calls startWorkers(1); a phase>1 job would never be
    // scheduled at all — the trap already documented for the trace workers.
    expect(job.phase).toBe(1);
    // An HOURLY TICK, not a cron derived from the interval: the interval is the
    // max acceptable AGE OF THE EVIDENCE, and the tick decides from the
    // evidence whether a drill is needed.
    expect(job.cron).toBe('40 * * * *');
    expect(job.cron).not.toMatch(/^0 \d+ \* \* \*$/);
    expect(typeof job.fn).toBe('function');
  });
});

describe('the registered job actually drills', () => {
  it('runs a drill when no drill has ever run', async () => {
    const job = registryJob();
    await job.fn();
    expect(drillSpy).toHaveBeenCalledTimes(1);
  });

  it('runs a drill when the evidence is older than the interval', async () => {
    facts.current.last_restore_drill_at = new Date(Date.now() - 400 * 3_600_000);
    facts.current.last_restore_drill_result = 'passed';
    facts.current.last_restore_drill_cleanup_status = 'clean';
    const job = registryJob();
    await job.fn();
    expect(drillSpy).toHaveBeenCalledTimes(1);
  });

  it('runs NOTHING when the evidence is fresh', async () => {
    facts.current.last_restore_drill_at = new Date(Date.now() - 2 * 3_600_000);
    facts.current.last_restore_drill_result = 'passed';
    facts.current.last_restore_drill_cleanup_status = 'clean';
    const job = registryJob();
    await job.fn();
    expect(drillSpy).not.toHaveBeenCalled();
  });

  it('does not reject when the drill fails — the verdict is the evidence', async () => {
    drillSpy.mockResolvedValue(drillResult({ status: 'failed', failure_code: 'restore_failed' }));
    const job = registryJob();
    await expect(job.fn()).resolves.toBeUndefined();
  });
});

describe('single-flight: two concurrent ticks, one drill', () => {
  it('the second tick loses the advisory lock and starts nothing', async () => {
    const job = registryJob();

    // Hold the first drill open so the two ticks genuinely overlap.
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    drillSpy.mockImplementation(async () => {
      await inFlight;
      return drillResult();
    });

    const first = job.fn();
    // Yield until the first tick has actually taken the lock.
    for (let i = 0; i < 50 && heldLocks.size === 0; i++) await Promise.resolve();
    expect(heldLocks.size).toBe(1);

    await job.fn();
    // The loser asked for the lock and was refused — it did not wait, and it
    // did not start a second drill against the same ephemeral database.
    expect(lockCalls.count).toBe(2);
    expect(drillSpy).toHaveBeenCalledTimes(1);

    release();
    await first;
    // The winner released the lock on its way out, so the next tick can run.
    expect(heldLocks.size).toBe(0);
  });
});
