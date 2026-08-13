/**
 * Issue #536, owner review of PR #553 — the crash window, against real Postgres.
 *
 * THE FINDING THIS SPEC HOLDS. The scheduler blocked a new drill when the last
 * TERMINAL drill reported `cleanup_status='unsafe'`. A drill whose process died
 * between `createDrill` and `finishDrill` leaves `status='running'` /
 * `cleanup_status='unknown'`, which `drill.ts` defines as "residue possible,
 * nobody checked" — and `readReadinessFacts` filtered that row out with
 * `status IN ('passed','failed')`. So the sequence below was allowed:
 *
 *   1. a drill starts, writes its row, materialises a decrypted copy of every
 *      tenant's data;
 *   2. the process dies — row stays `running`, teardown never proven;
 *   3. the restart releases the advisory lock (it is a SESSION lock);
 *   4. the previous terminal evidence ages into the due window;
 *   5. the worker starts another drill and makes a SECOND copy, with the first
 *      never proven gone.
 *
 * Every step above is exercised here against the real database and the real
 * production path: the real `restoreDrillStore.createDrill` writes the row, the
 * real `readReadinessFacts` reads it, the real `tryAcquireOpsLock` proves the
 * lock is free after the "restart", and the real `runRestoreDrillTick` decides.
 * Nothing about the decision is reconstructed locally — reintroducing
 * `IN ('passed','failed')` in `readReadinessFacts` turns these cases red.
 *
 * Skipped without TEST_DB_URL (the unit-only lane passes without Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readReadinessFacts, restoreDrillStore } from '@/db/repositories/ops-repos.js';
import { OPS_LOCK_KEYS, tryAcquireOpsLock, type LockPool } from '@/ops/backup/single-flight.js';
import {
  runRestoreDrillTick,
  type DrillInvocation,
  type RestoreDrillTickPorts,
} from '@/ops/backup/drill-schedule.js';
import { abandonedDrillAfterMs } from '@/ops/backup/rpo.js';
import { resolveBackupProfile, type BackupConfigInput } from '@/ops/backup/profile.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

/** Namespaced so a parallel suite's rows can never be mistaken for ours. */
const CORR = 'ops553-crash';

const HOURS = 3_600_000;

function profile(over: Partial<BackupConfigInput> = {}) {
  return resolveBackupProfile({
    profile: 'production',
    BACKUP_ENABLED: true,
    BACKUP_DIR: '/backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    BACKUP_DUMP_TIMEOUT_MS: 3_600_000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1_800_000,
    BACKUP_RESTORE_TIMEOUT_MS: 3_600_000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
    ...over,
  });
}

/** The real writer the drill uses on its first step — not a hand-rolled INSERT. */
async function crashAfterCreateDrill(): Promise<string> {
  const id = randomUUID();
  await restoreDrillStore.createDrill({
    id,
    correlation_id: CORR,
    backup_run_id: null,
    source: 'local',
  });
  // …and the process dies here. `finishDrill` is never called, so the row keeps
  // `status='running'` and `cleanup_status='unknown'`.
  return id;
}

/** A drill that DID finish, old enough that the gate is due for a refresh. */
async function insertTerminalDrill(agoMs: number): Promise<void> {
  const at = new Date(Date.now() - agoMs);
  await pool.query(
    `INSERT INTO restore_drills
       (correlation_id, source, started_at, finished_at, duration_ms, status, cleanup_status)
     VALUES ($1, 'local', $2, $2, 90000, 'passed', 'clean')`,
    [CORR, at],
  );
}

interface Harness {
  ports: RestoreDrillTickPorts;
  drills: () => number;
  logs: Array<{ level: string; event: string; detail: Record<string, unknown> }>;
}

/** Ports whose `readFacts` is the REAL repository read. */
function harness(now: Date): Harness {
  const logs: Harness['logs'] = [];
  let calls = 0;
  return {
    logs,
    drills: () => calls,
    ports: {
      now: () => now,
      readFacts: readReadinessFacts,
      runDrill: async (): Promise<DrillInvocation> => {
        calls += 1;
        return { status: 'ran', drill_status: 'passed' };
      },
      log: (level, event, detail) => logs.push({ level, event, detail }),
    },
  };
}

d('restore drill — the crash window (issue #536, review da #553)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM restore_drills WHERE correlation_id = $1', [CORR]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM restore_drills WHERE correlation_id = $1', [CORR]);
  });

  it('a drill that died after createDrill is VISIBLE to the readiness facts', async () => {
    await crashAfterCreateDrill();
    const facts = await readReadinessFacts();
    // The row exists and the facts admit it. Before the fix this was null: the
    // query only looked at terminal rows, so the state that means "residue
    // possible, nobody checked" was invisible to every consumer.
    expect(facts.open_restore_drill_started_at).toBeInstanceOf(Date);
    // …and it did NOT contaminate the terminal fields, which still describe the
    // newest FINISHED drill (here: none).
    expect(facts.last_restore_drill_at).toBeNull();
    expect(facts.last_restore_drill_result).toBeNull();
  });

  it('the restart really does free the advisory lock — nothing else would stop a second drill', async () => {
    await crashAfterCreateDrill();
    // `pg_try_advisory_lock` is a SESSION lock: the dead process took its lock
    // with it. A fresh session — which is what a restarted worker is — takes it
    // without contention. This is why the row-level block has to exist: there
    // is no other survivor of the crash that would refuse the second drill.
    const lock = await tryAcquireOpsLock(OPS_LOCK_KEYS.restore_drill, {
      pool: pool as unknown as LockPool,
    });
    expect(lock, 'the drill lock was still held after a simulated restart').not.toBeNull();
    await lock!.release();
  });

  it('blocks the next drill while the crashed execution is unaccounted for', async () => {
    // The full sequence: previous evidence is old enough to be due…
    await insertTerminalDrill(200 * HOURS);
    // …a drill crashed after writing its row…
    await crashAfterCreateDrill();

    // The open fact must point at the CRASHED execution — the row created
    // moments ago — and not at the terminal drill from 200h back. Without this
    // the case would still pass with the old `IN ('passed','failed')` filter,
    // which returns an ancient timestamp that happens to look abandoned too.
    const facts = await readReadinessFacts();
    expect(facts.open_restore_drill_started_at).toBeInstanceOf(Date);
    expect(facts.open_restore_drill_started_at!.getTime()).toBeGreaterThan(
      Date.now() - 5 * 60_000,
    );
    expect(facts.last_restore_drill_at!.getTime()).toBeLessThan(Date.now() - 100 * HOURS);

    // …and the worker wakes up well past the abandonment cutoff.
    const now = new Date(Date.now() + abandonedDrillAfterMs(profile()) + HOURS);
    const h = harness(now);
    const res = await runRestoreDrillTick(h.ports, profile());

    // Precondition of the finding: without the crashed row, this tick WOULD
    // have drilled — the terminal evidence is past its due window.
    expect(res.decision.evidence_age_seconds).toBeGreaterThan(res.decision.due_after_seconds);
    // The fix: no second copy of production is made.
    expect(h.drills()).toBe(0);
    expect(res.outcome).toBe('not_due');
    expect(res.decision.reason).toBe('abandoned_drill_blocks');
    // Distinguishable from "teardown ran and failed" — the two ask for
    // different things from the operator.
    expect(res.decision.reason).not.toBe('residue_blocks_drill');
    expect(h.logs.find((l) => l.event === 'restore_drill.blocked_by_abandoned_drill')?.level).toBe(
      'error',
    );
    // And the scraped gate is red, not green: a fresh-looking terminal drill
    // must not paint OK over an unaccounted-for copy of production.
    expect(res.drill_check_level).toBe('FAIL');
  });

  it('turns the gate RED even when the terminal evidence still looks fresh', async () => {
    // The dangerous shape: a drill passed yesterday, so drill AGE alone grades
    // OK and `/metrics` would paint `maia_restore_drill_check_level = 0` for
    // days — while a decrypted copy of every tenant's data may be sitting on
    // this host from an execution nobody accounted for.
    await insertTerminalDrill(24 * HOURS);
    await crashAfterCreateDrill();

    const now = new Date(Date.now() + abandonedDrillAfterMs(profile()) + HOURS);
    const h = harness(now);
    const res = await runRestoreDrillTick(h.ports, profile());

    // Age alone would have said OK…
    expect(res.decision.evidence_age_seconds).toBeLessThan(res.decision.max_age_seconds);
    expect(res.decision.evidence_expired).toBe(false);
    // …and the gate says FAIL anyway, on the same series the alert queries.
    expect(res.drill_check_level).toBe('FAIL');
    expect(res.readiness_level).toBe('FAIL');
    expect(res.decision.reason).toBe('abandoned_drill_blocks');
    expect(h.drills()).toBe(0);
  });

  it('a drill still inside its budget reads as IN FLIGHT, not as a corpse', async () => {
    await insertTerminalDrill(200 * HOURS);
    await crashAfterCreateDrill();

    // Same row, clock a minute later: this is what a healthy drill looks like
    // from the outside, and it must not page anyone.
    const h = harness(new Date(Date.now() + 60_000));
    const res = await runRestoreDrillTick(h.ports, profile());

    expect(res.decision.reason).toBe('drill_in_flight');
    expect(h.drills()).toBe(0);
    expect(h.logs.some((l) => l.event === 'restore_drill.blocked_by_abandoned_drill')).toBe(false);
  });

  it('drills again once the crashed row is terminalized', async () => {
    await insertTerminalDrill(200 * HOURS);
    const crashed = await crashAfterCreateDrill();

    // The operator cleans the host and closes the row — the documented unlock
    // (runbook §4.2). `unsafe` would keep blocking on the OTHER rule, so the
    // honest close of a verified-clean host is what is exercised here.
    await pool.query(
      `UPDATE restore_drills
          SET status = 'failed', finished_at = now(), failure_code = 'unexpected',
              cleanup_status = 'clean'
        WHERE id = $1`,
      [crashed],
    );

    const facts = await readReadinessFacts();
    expect(
      facts.open_restore_drill_started_at,
      'another suite left a non-terminal restore_drills row; this case needs none',
    ).toBeNull();

    // Closing the row as `failed` makes it the newest TERMINAL drill, so the
    // (shorter) retry window governs from here — 12.5% of 168h ≈ 21h. That is
    // the real unlock path, and the clock has to clear it.
    const early = harness(new Date(Date.now() + HOURS));
    expect((await runRestoreDrillTick(early.ports, profile())).decision.reason).toBe(
      'evidence_fresh',
    );
    expect(early.drills()).toBe(0);

    const h = harness(new Date(Date.now() + 30 * HOURS));
    const res = await runRestoreDrillTick(h.ports, profile());
    expect(res.decision.reason).toBe('retry_after_failure');
    expect(h.drills()).toBe(1);
    expect(res.outcome).toBe('ran');
  });

  it('the block survives a tick that would otherwise RETRY a failed drill', async () => {
    // The retry window is much shorter than the refresh window, so it is the
    // path most likely to fire soon after a crash.
    await pool.query(
      `INSERT INTO restore_drills
         (correlation_id, source, started_at, finished_at, duration_ms, status,
          failure_code, cleanup_status)
       VALUES ($1, 'local', $2, $2, 5000, 'failed', 'restore_failed', 'clean')`,
      [CORR, new Date(Date.now() - 100 * HOURS)],
    );
    await crashAfterCreateDrill();

    const facts = await readReadinessFacts();
    // Same guard as above: the block must come from the crashed row, not from
    // the terminal one the old filter would have returned.
    expect(facts.open_restore_drill_started_at!.getTime()).toBeGreaterThan(
      Date.now() - 5 * 60_000,
    );

    const now = new Date(Date.now() + abandonedDrillAfterMs(profile()) + HOURS);
    const h = harness(now);
    const res = await runRestoreDrillTick(h.ports, profile());

    expect(res.decision.reason).toBe('abandoned_drill_blocks');
    expect(h.drills()).toBe(0);
  });

  it('the abandonment cutoff is derived from the profile budgets, with a floor', async () => {
    // 2 × (upload + restore) — the same "twice the budget" rule
    // `reclaimAbandonedRuns` uses on backup_runs. Shipped defaults ⇒ 3h.
    expect(abandonedDrillAfterMs(profile())).toBe(2 * (1_800_000 + 3_600_000));
    // …and never below the floor, so a dev profile with millisecond budgets
    // cannot declare a live drill dead seconds after it started.
    expect(
      abandonedDrillAfterMs(
        profile({ BACKUP_UPLOAD_TIMEOUT_MS: 1000, BACKUP_RESTORE_TIMEOUT_MS: 1000 }),
      ),
    ).toBe(3_600_000);
  });
});
