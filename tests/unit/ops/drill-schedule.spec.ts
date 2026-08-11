import { describe, it, expect } from 'vitest';
import {
  DRILL_DUE_FRACTION,
  DRILL_RETRY_FRACTION,
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
