import { describe, it, expect } from 'vitest';
import {
  DRILL_DUE_FRACTION,
  DRILL_RETRY_FRACTION,
  DRILL_TICK_HOURS,
  minHonourableDrillIntervalHours,
  restoreDrillDue,
  runRestoreDrillTick,
  type DrillEvidenceFacts,
  type DrillInvocation,
  type RestoreDrillScheduleInput,
  type RestoreDrillTickPorts,
} from '../../../src/ops/backup/drill-schedule.js';
import {
  resolveBackupProfile,
  type BackupConfigInput,
} from '../../../src/ops/backup/profile.js';

/**
 * Issue #536 — the restore drill as a SCHEDULED gate.
 *
 * The properties defended here, one line each:
 *   - fresh evidence runs NOTHING (a drill is expensive and, while it runs,
 *     a plaintext copy of production is on disk);
 *   - evidence past the interval REPROVES and triggers a drill;
 *   - having NEVER drilled reproves — absence of evidence is not evidence;
 *   - a failed drill retries on its own, shorter window;
 *   - a drill that left residue BLOCKS the next one instead of making a
 *     second copy of production;
 *   - nothing this path logs can carry DATABASE_URL (issue #520's real leak).
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');
const HOURS = 3_600_000;
const INTERVAL_HOURS = 168;

function cfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    profile: 'development',
    BACKUP_ENABLED: true,
    BACKUP_DIR: '/backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
    BACKUP_DUMP_TIMEOUT_MS: 1000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1000,
    BACKUP_RESTORE_TIMEOUT_MS: 1000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: INTERVAL_HOURS,
    RETENTION_DRY_RUN: true,
    ...over,
  };
}

function prodCfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return cfg({
    profile: 'production',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    ...over,
  });
}

const devProfile = (over: Partial<BackupConfigInput> = {}) => resolveBackupProfile(cfg(over));
const prodProfile = (over: Partial<BackupConfigInput> = {}) =>
  resolveBackupProfile(prodCfg(over));

function schedule(over: Partial<RestoreDrillScheduleInput> = {}) {
  return restoreDrillDue({
    now: NOW,
    profile: devProfile(),
    last_restore_drill_at: new Date(NOW.getTime() - 24 * HOURS),
    last_restore_drill_result: 'passed',
    last_restore_drill_cleanup_status: 'clean',
    open_restore_drill_started_at: null,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// restoreDrillDue — the pure decision
// ---------------------------------------------------------------------------
describe('restoreDrillDue — the interval is a MAX AGE, not a schedule', () => {
  it('does nothing while the evidence is fresh', () => {
    const d = schedule({ last_restore_drill_at: new Date(NOW.getTime() - 24 * HOURS) });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('evidence_fresh');
    expect(d.evidence_expired).toBe(false);
  });

  it('becomes due at 75% of the interval — BEFORE the evidence expires', () => {
    const dueAt = INTERVAL_HOURS * DRILL_DUE_FRACTION;
    expect(schedule({ last_restore_drill_at: new Date(NOW.getTime() - (dueAt - 1) * HOURS) }).due)
      .toBe(false);
    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - (dueAt + 1) * HOURS),
    });
    expect(d.due).toBe(true);
    expect(d.reason).toBe('evidence_stale');
    // The point of firing early: the evidence is due for refresh but has NOT
    // expired yet, so the drill has the remaining budget to complete.
    expect(d.evidence_expired).toBe(false);
  });

  it('marks evidence older than the full interval as EXPIRED', () => {
    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - (INTERVAL_HOURS + 1) * HOURS),
    });
    expect(d.due).toBe(true);
    expect(d.evidence_expired).toBe(true);
  });

  it('treats NEVER having drilled as due AND expired — absence is not evidence', () => {
    const d = schedule({
      last_restore_drill_at: null,
      last_restore_drill_result: null,
      last_restore_drill_cleanup_status: null,
    });
    expect(d.due).toBe(true);
    expect(d.reason).toBe('never_ran');
    expect(d.evidence_expired).toBe(true);
    expect(d.evidence_age_seconds).toBeNull();
  });

  it('retries a FAILED drill on its own, shorter window', () => {
    const retryAt = INTERVAL_HOURS * DRILL_RETRY_FRACTION;
    const fresh = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - (retryAt - 1) * HOURS),
      last_restore_drill_result: 'failed',
    });
    expect(fresh.due).toBe(false);

    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - (retryAt + 1) * HOURS),
      last_restore_drill_result: 'failed',
    });
    expect(d.due).toBe(true);
    expect(d.reason).toBe('retry_after_failure');
    // Much sooner than a PASSED drill would be re-run.
    expect(d.due_after_seconds).toBeLessThan(INTERVAL_HOURS * DRILL_DUE_FRACTION * 3600);
  });

  it('REFUSES to start a drill while the previous one left residue on the host', () => {
    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - 5 * INTERVAL_HOURS * HOURS),
      last_restore_drill_result: 'failed',
      last_restore_drill_cleanup_status: 'unsafe',
    });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('residue_blocks_drill');
    // ...and it is still EXPIRED: refusing to drill never reads as "fine".
    expect(d.evidence_expired).toBe(true);
  });

  it('BLOCKS while an execution has no proven teardown, with its own reason', () => {
    // A drill that died after `createDrill` leaves `running` /
    // `cleanup_status='unknown'` — "residue possible, nobody checked". Starting
    // another would make a SECOND decrypted copy of production.
    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - 500 * HOURS),
      open_restore_drill_started_at: new Date(NOW.getTime() - 48 * HOURS),
    });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('abandoned_drill_blocks');
    // NOT the same diagnosis as a teardown that ran and failed: that one says
    // "we know a copy is there", this one says "nobody looked".
    expect(d.reason).not.toBe('residue_blocks_drill');
  });

  it('reads a young non-terminal row as a drill IN FLIGHT, not as a corpse', () => {
    const d = schedule({
      last_restore_drill_at: new Date(NOW.getTime() - 500 * HOURS),
      open_restore_drill_started_at: new Date(NOW.getTime() - 60_000),
    });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('drill_in_flight');
  });

  it('uses the profile budgets for the abandonment cutoff, not a bare constant', () => {
    // 2 × (upload + restore), floored at 1h — the same "twice the budget" rule
    // `reclaimAbandonedRuns` applies to backup_runs.
    const slow = devProfile({
      BACKUP_UPLOAD_TIMEOUT_MS: 4 * 3_600_000,
      BACKUP_RESTORE_TIMEOUT_MS: 4 * 3_600_000,
    });
    // 12h old, cutoff 16h ⇒ still in flight under the slow profile…
    const inFlight = schedule({
      profile: slow,
      open_restore_drill_started_at: new Date(NOW.getTime() - 12 * HOURS),
    });
    expect(inFlight.reason).toBe('drill_in_flight');
    // …and a corpse under the default one.
    const corpse = schedule({
      open_restore_drill_started_at: new Date(NOW.getTime() - 12 * HOURS),
    });
    expect(corpse.reason).toBe('abandoned_drill_blocks');
  });

  it('an unaccounted-for execution outranks even a never-run gate', () => {
    // "Never drilled" is normally the strongest reason to drill NOW. It still
    // loses to "a copy of production may be on the host".
    const d = schedule({
      last_restore_drill_at: null,
      last_restore_drill_result: null,
      last_restore_drill_cleanup_status: null,
      open_restore_drill_started_at: new Date(NOW.getTime() - 48 * HOURS),
    });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('abandoned_drill_blocks');
  });

  it('runs nothing when backups are disabled by configuration', () => {
    const d = schedule({
      profile: devProfile({ BACKUP_ENABLED: false }),
      last_restore_drill_at: null,
    });
    expect(d.due).toBe(false);
    expect(d.reason).toBe('backups_disabled');
  });

  it('derives its windows from BACKUP_RESTORE_DRILL_INTERVAL_HOURS, not a constant', () => {
    const d = schedule({ profile: devProfile({ BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 24 }) });
    expect(d.max_age_seconds).toBe(24 * 3600);
    expect(d.due_after_seconds).toBe(Math.round(24 * 3600 * DRILL_DUE_FRACTION));
  });
});

// ---------------------------------------------------------------------------
// runRestoreDrillTick — the gate
// ---------------------------------------------------------------------------
type LogLine = { level: string; event: string; detail: Record<string, unknown> };

function facts(over: Partial<DrillEvidenceFacts> = {}): DrillEvidenceFacts {
  return {
    last_local_verified_at: new Date(NOW.getTime() - 2 * HOURS),
    last_offsite_verified_at: new Date(NOW.getTime() - 2 * HOURS),
    last_restore_drill_at: new Date(NOW.getTime() - 24 * HOURS),
    last_restore_drill_result: 'passed',
    last_restore_drill_duration_ms: 90_000,
    last_restore_drill_cleanup_status: 'clean',
    open_restore_drill_started_at: null,
    consecutive_failures: 0,
    ...over,
  };
}

function harness(opts: {
  facts?: DrillEvidenceFacts;
  readFacts?: () => Promise<DrillEvidenceFacts>;
  runDrill?: () => Promise<DrillInvocation>;
} = {}) {
  const logs: LogLine[] = [];
  let drillCalls = 0;
  const ports: RestoreDrillTickPorts = {
    now: () => NOW,
    readFacts: opts.readFacts ?? (async () => opts.facts ?? facts()),
    runDrill:
      opts.runDrill ??
      (async () => {
        drillCalls += 1;
        return { status: 'ran', drill_status: 'passed' };
      }),
    log: (level, event, detail) => logs.push({ level, event, detail }),
  };
  return { ports, logs, drills: () => drillCalls };
}

describe('runRestoreDrillTick — fresh evidence is green and costs nothing', () => {
  it('grades OK and starts no drill', async () => {
    const h = harness();
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.drill_check_level).toBe('OK');
    expect(res.outcome).toBe('not_due');
    expect(h.drills()).toBe(0);
    expect(h.logs.map((l) => l.event)).toContain('restore_drill.evidence_ok');
  });
});

describe('runRestoreDrillTick — aged-out evidence REPROVES', () => {
  it('grades FAIL and drills when the last drill is older than the interval', async () => {
    const h = harness({
      facts: facts({
        last_restore_drill_at: new Date(NOW.getTime() - (INTERVAL_HOURS + 10) * HOURS),
      }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.drill_check_level).toBe('FAIL');
    expect(res.decision.evidence_expired).toBe(true);
    expect(res.outcome).toBe('ran');
    expect(h.drills()).toBe(1);
    const line = h.logs.find((l) => l.event === 'restore_drill.evidence_expired');
    expect(line?.level).toBe('error');
  });

  it('grades FAIL for a drill that FAILED, however recent it is', async () => {
    const h = harness({
      facts: facts({
        last_restore_drill_at: new Date(NOW.getTime() - 1 * HOURS),
        last_restore_drill_result: 'failed',
      }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.drill_check_level).toBe('FAIL');
  });
});

describe('runRestoreDrillTick — absence of evidence is not evidence of success', () => {
  it('never having drilled grades FAIL in production and triggers the first drill', async () => {
    const h = harness({
      facts: facts({
        last_restore_drill_at: null,
        last_restore_drill_result: null,
        last_restore_drill_duration_ms: null,
        last_restore_drill_cleanup_status: null,
      }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.drill_check_level).toBe('FAIL');
    expect(res.readiness_level).toBe('FAIL');
    expect(res.outcome).toBe('ran');
    expect(h.drills()).toBe(1);
  });

  it('an UNREADABLE evidence table grades FAIL and drills nothing', async () => {
    const h = harness({
      readFacts: async () => {
        throw new Error('connection terminated');
      },
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.outcome).toBe('evidence_unreadable');
    expect(res.drill_check_level).toBe('FAIL');
    expect(res.readiness_level).toBe('FAIL');
    expect(h.drills()).toBe(0);
    // "Unknown", not "never ran" — the two are different diagnoses and the
    // verdict must not claim the stronger one.
    expect(res.decision.reason).toBe('evidence_unreadable');
    expect(res.decision.evidence_expired).toBe(true);
  });
});

describe('minHonourableDrillIntervalHours — the floor the boot gate enforces', () => {
  const TICK = 1;
  const UPLOAD = 30 * 60_000;
  const RESTORE = 60 * 60_000;

  it('is 10h with the shipped defaults', () => {
    // (1h tick + 30min upload + 60min restore) = 2.5h of worst case, which has
    // to fit in the 25% of the interval left after the drill becomes due:
    // 2.5 / 0.25 = 10.
    expect(
      minHonourableDrillIntervalHours({ tickHours: TICK, uploadMs: UPLOAD, restoreMs: RESTORE }),
    ).toBe(10);
  });

  it('is the worst case divided by the margin left after the due point', () => {
    // The `4×` is not a magic number: it IS 1 / (1 - DRILL_DUE_FRACTION), so
    // the identity below has to hold for any inputs.
    for (const [tickHours, uploadMs, restoreMs] of [
      [1, 30 * 60_000, 60 * 60_000],
      [1, 15 * 60_000, 30 * 60_000],
      [2, 60 * 60_000, 60 * 60_000],
      [1, 0, 0],
    ] as const) {
      const worstCaseHours = tickHours + (uploadMs + restoreMs) / 3_600_000;
      expect(minHonourableDrillIntervalHours({ tickHours, uploadMs, restoreMs })).toBe(
        Math.ceil(worstCaseHours / (1 - DRILL_DUE_FRACTION)),
      );
    }
  });

  it('follows the due fraction, so moving the margin cannot silently invalidate it', () => {
    // Guards the derivation itself: if someone changes when the drill fires,
    // the floor must move with it. 1/(1-0.75) = 4.
    expect(1 / (1 - DRILL_DUE_FRACTION)).toBe(4);
    expect(
      minHonourableDrillIntervalHours({ tickHours: TICK, uploadMs: UPLOAD, restoreMs: RESTORE }),
    ).toBe(Math.ceil(2.5 * (1 / (1 - DRILL_DUE_FRACTION))));
  });

  it('rounds UP — a fractional floor is still a floor', () => {
    // 1h + 10min + 10min = 1.333h ⇒ 5.33h ⇒ 6h. Rounding down would license an
    // interval the scheduler provably cannot honour.
    expect(
      minHonourableDrillIntervalHours({
        tickHours: 1,
        uploadMs: 10 * 60_000,
        restoreMs: 10 * 60_000,
      }),
    ).toBe(6);
  });

  it('is the value the tick cadence in the registry actually uses', () => {
    // The floor is only true for the cadence the worker really runs at.
    expect(DRILL_TICK_HOURS).toBe(1);
  });
});

describe('runRestoreDrillTick — an unaccounted-for execution is reported loudly', () => {
  it('logs its own event, distinct from the residue one, and reddens the gate', async () => {
    const h = harness({
      facts: facts({
        // Terminal evidence FRESH: age alone would grade OK.
        last_restore_drill_at: new Date(NOW.getTime() - 24 * HOURS),
        open_restore_drill_started_at: new Date(NOW.getTime() - 48 * HOURS),
      }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());

    expect(h.drills()).toBe(0);
    expect(res.decision.reason).toBe('abandoned_drill_blocks');
    expect(res.drill_check_level).toBe('FAIL');
    const line = h.logs.find((l) => l.event === 'restore_drill.blocked_by_abandoned_drill');
    expect(line?.level).toBe('error');
    expect(line?.detail.open_drill_age_seconds).toBe(48 * 3600);
    // The two emergencies never share an event name.
    expect(h.logs.some((l) => l.event === 'restore_drill.blocked_by_residue')).toBe(false);
  });
});

describe('runRestoreDrillTick — single-flight and residue', () => {
  it('reports already_running without starting a second drill', async () => {
    const h = harness({
      facts: facts({ last_restore_drill_at: null, last_restore_drill_result: null }),
      runDrill: async () => ({ status: 'already_running' }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.outcome).toBe('already_running');
  });

  it('refuses to drill while the previous drill left a copy of production behind', async () => {
    const h = harness({
      facts: facts({
        last_restore_drill_at: new Date(NOW.getTime() - 10 * INTERVAL_HOURS * HOURS),
        last_restore_drill_result: 'failed',
        last_restore_drill_cleanup_status: 'unsafe',
      }),
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.outcome).toBe('not_due');
    expect(h.drills()).toBe(0);
    // Not silent: the refusal is louder than the drill would have been.
    expect(h.logs.find((l) => l.event === 'restore_drill.blocked_by_residue')?.level).toBe(
      'error',
    );
    expect(res.drill_check_level).toBe('FAIL');
  });
});

// ---------------------------------------------------------------------------
// Issue #520's real leak: pg_dump/pg_restore echo DATABASE_URL on failure.
// ---------------------------------------------------------------------------
describe('runRestoreDrillTick — no credential ever reaches a log', () => {
  const LEAK =
    'connection to server failed: postgres://maia:sup3rs3cr3t@db.internal:5432/maia_prod';

  function assertClean(logs: LogLine[]): void {
    const body = JSON.stringify(logs);
    expect(body).not.toContain('sup3rs3cr3t');
    expect(body).not.toContain('db.internal');
    expect(body).not.toMatch(/postgres:\/\//);
    expect(body).toContain('[redacted]');
  }

  it('redacts a connection URL thrown while READING the evidence', async () => {
    const h = harness({
      readFacts: async () => {
        throw new Error(LEAK);
      },
    });
    await runRestoreDrillTick(h.ports, prodProfile());
    assertClean(h.logs);
  });

  it('redacts a connection URL thrown by the DRILL itself', async () => {
    const h = harness({
      facts: facts({ last_restore_drill_at: null, last_restore_drill_result: null }),
      runDrill: async () => {
        throw new Error(`pg_restore: error: ${LEAK}`);
      },
    });
    const res = await runRestoreDrillTick(h.ports, prodProfile());
    expect(res.outcome).toBe('error');
    assertClean(h.logs);
  });
});
