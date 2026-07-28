import { describe, it, expect } from 'vitest';
import {
  evaluateBackupReadiness,
  rtoWithinTarget,
  readinessGauges,
  type BackupReadinessInput,
} from '../../../src/ops/backup/rpo.js';
import { resolveBackupProfile, type BackupConfigInput } from '../../../src/ops/backup/profile.js';

/**
 * Issue #520 §8 — "idade do último backup restaurável é calculada"; "UI/doctor
 * diferencia backup criado, uploaded, verified e restored"; "não há promessa
 * de RPO menor que a capacidade real".
 */

const NOW = new Date('2026-07-28T12:00:00.000Z');
const HOURS = 3_600_000;

function cfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    NODE_ENV: 'development',
    BACKUP_ENABLED: true,
    BACKUP_DIR: './backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
    BACKUP_DUMP_TIMEOUT_MS: 1000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1000,
    BACKUP_RESTORE_TIMEOUT_MS: 1000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
    ...over,
  };
}

function prodCfg(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return cfg({
    NODE_ENV: 'production',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"x"}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    ...over,
  });
}

function input(
  over: Partial<BackupReadinessInput> = {},
  config: BackupConfigInput = cfg(),
): BackupReadinessInput {
  return {
    now: NOW,
    profile: resolveBackupProfile(config),
    last_local_verified_at: new Date(NOW.getTime() - 2 * HOURS),
    last_offsite_verified_at: new Date(NOW.getTime() - 2 * HOURS),
    last_restore_drill_at: new Date(NOW.getTime() - 24 * HOURS),
    last_restore_drill_result: 'passed',
    last_restore_drill_duration_ms: 90_000,
    consecutive_failures: 0,
    ...over,
  };
}

function check(res: ReturnType<typeof evaluateBackupReadiness>, id: string) {
  const c = res.checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe('healthy production posture', () => {
  it('reports OK when every objective is met', () => {
    const res = evaluateBackupReadiness(input({}, prodCfg()));
    expect(res.level).toBe('OK');
    expect(res.measured_rpo_seconds).toBe(2 * 3600);
    expect(res.measured_rto_seconds).toBe(90);
  });

  it('measures RPO from the OFF-SITE copy when the profile requires it', () => {
    const res = evaluateBackupReadiness(
      input(
        {
          last_local_verified_at: new Date(NOW.getTime() - 1 * HOURS),
          last_offsite_verified_at: new Date(NOW.getTime() - 6 * HOURS),
        },
        prodCfg(),
      ),
    );
    // The local copy is fresher, but it is not the authoritative one.
    expect(res.measured_rpo_seconds).toBe(6 * 3600);
  });
});

describe('local recovery point', () => {
  it('FAILs when no verified local backup has ever existed', () => {
    const res = evaluateBackupReadiness(input({ last_local_verified_at: null }));
    expect(check(res, 'backup_age_local').level).toBe('FAIL');
    expect(check(res, 'backup_age_local').evidence.verified).toBe(false);
  });

  it('WARNs BEFORE the violation (early warning at 75% of the budget)', () => {
    const res = evaluateBackupReadiness(
      input({ last_local_verified_at: new Date(NOW.getTime() - 20 * HOURS) }),
    );
    expect(check(res, 'backup_age_local').level).toBe('WARN');
  });

  it('FAILs once the age exceeds the RPO target', () => {
    const res = evaluateBackupReadiness(
      input({ last_local_verified_at: new Date(NOW.getTime() - 30 * HOURS) }),
    );
    expect(check(res, 'backup_age_local').level).toBe('FAIL');
  });
});

describe('off-site recovery point', () => {
  it('FAILs in production when no off-site copy was ever verified', () => {
    const res = evaluateBackupReadiness(input({ last_offsite_verified_at: null }, prodCfg()));
    expect(check(res, 'backup_age_offsite').level).toBe('FAIL');
    expect(res.level).toBe('FAIL');
  });

  it('never reports OK when no destination is configured at all', () => {
    const res = evaluateBackupReadiness(input({ last_offsite_verified_at: null }));
    expect(check(res, 'backup_age_offsite').level).toBe('WARN');
    expect(check(res, 'backup_age_offsite').evidence.configured).toBe(false);
  });

  it('WARNs when a configured but non-mandatory destination is stale', () => {
    const res = evaluateBackupReadiness(
      input({ last_offsite_verified_at: null }, cfg({ BACKUP_S3_BUCKET: 'b' })),
    );
    expect(check(res, 'backup_age_offsite').level).toBe('WARN');
  });
});

describe('restore drill — the only proof a backup is restorable', () => {
  it('FAILs outright when the last drill failed', () => {
    const res = evaluateBackupReadiness(
      input({ last_restore_drill_result: 'failed', last_restore_drill_duration_ms: null }),
    );
    expect(check(res, 'restore_drill_age').level).toBe('FAIL');
    expect(res.level).toBe('FAIL');
  });

  it('FAILs in production when no drill has ever run', () => {
    const res = evaluateBackupReadiness(
      input(
        { last_restore_drill_at: null, last_restore_drill_result: null, last_restore_drill_duration_ms: null },
        prodCfg(),
      ),
    );
    expect(check(res, 'restore_drill_age').level).toBe('FAIL');
  });

  it('only WARNs outside production when no drill has ever run', () => {
    const res = evaluateBackupReadiness(
      input({
        last_restore_drill_at: null,
        last_restore_drill_result: null,
        last_restore_drill_duration_ms: null,
      }),
    );
    expect(check(res, 'restore_drill_age').level).toBe('WARN');
  });

  it('does not report a measured RTO from a failed drill', () => {
    const res = evaluateBackupReadiness(
      input({ last_restore_drill_result: 'failed', last_restore_drill_duration_ms: 500_000 }),
    );
    expect(res.measured_rto_seconds).toBeNull();
  });
});

describe('consecutive failures and encryption posture', () => {
  it('escalates WARN → FAIL as failures accumulate', () => {
    expect(check(evaluateBackupReadiness(input({ consecutive_failures: 0 })), 'backup_consecutive_failures').level).toBe('OK');
    expect(check(evaluateBackupReadiness(input({ consecutive_failures: 1 })), 'backup_consecutive_failures').level).toBe('WARN');
    expect(check(evaluateBackupReadiness(input({ consecutive_failures: 3 })), 'backup_consecutive_failures').level).toBe('FAIL');
  });

  it('FAILs when encryption is required but no key is usable', () => {
    const res = evaluateBackupReadiness(
      input({}, prodCfg({ BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined })),
    );
    expect(check(res, 'backup_encryption').level).toBe('FAIL');
  });

  it('exposes only the key IDENTIFIER as evidence', () => {
    const ev = check(evaluateBackupReadiness(input({}, prodCfg())), 'backup_encryption').evidence;
    expect(ev.active_key_id).toBe('k1');
    expect(JSON.stringify(ev)).not.toContain('keyring');
  });
});

describe('objective feasibility', () => {
  it('FAILs an RPO the nightly cadence cannot honour', () => {
    const res = evaluateBackupReadiness(input({}, cfg({ BACKUP_RPO_TARGET_HOURS: 4 })));
    expect(check(res, 'rpo_feasibility').level).toBe('FAIL');
  });

  it('reports rtoWithinTarget, distinguishing "unknown" from "within"', () => {
    const profile = resolveBackupProfile(cfg());
    const ok = evaluateBackupReadiness(input());
    expect(rtoWithinTarget(ok, profile)).toBe(true);

    const slow = evaluateBackupReadiness(input({ last_restore_drill_duration_ms: 5 * HOURS }));
    expect(rtoWithinTarget(slow, profile)).toBe(false);

    const never = evaluateBackupReadiness(
      input({ last_restore_drill_result: null, last_restore_drill_duration_ms: null }),
    );
    expect(rtoWithinTarget(never, profile)).toBeNull();
  });
});

describe('disabled backups', () => {
  it('short-circuits to WARN and reports no recovery point', () => {
    const res = evaluateBackupReadiness(input({}, cfg({ BACKUP_ENABLED: false })));
    expect(res.level).toBe('WARN');
    expect(res.measured_rpo_seconds).toBeNull();
    expect(res.checks.map((c) => c.id)).toEqual(['backup_enabled']);
  });
});

describe('evidence and remediation hygiene', () => {
  it('every check carries evidence and actionable remediation', () => {
    for (const c of evaluateBackupReadiness(input({}, prodCfg())).checks) {
      expect(Object.keys(c.evidence).length).toBeGreaterThan(0);
      expect(c.remediation.length).toBeGreaterThan(20);
    }
  });

  it('never emits a path, URL or credential in evidence', () => {
    const body = JSON.stringify(evaluateBackupReadiness(input({}, prodCfg())));
    expect(body).not.toMatch(/postgres:\/\//);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/\/opt\//);
  });
});

describe('readinessGauges', () => {
  it('emits low-cardinality, label-free gauges', () => {
    const g = readinessGauges(evaluateBackupReadiness(input({}, prodCfg())));
    expect(g.maia_backup_readiness_level).toBe(0);
    expect(g.maia_backup_age_seconds).toBe(2 * 3600);
    expect(g.maia_restore_drill_duration_seconds).toBe(90);
    for (const k of Object.keys(g)) expect(k).not.toMatch(/\{/);
  });

  it('omits gauges whose value was never measured', () => {
    const g = readinessGauges(
      evaluateBackupReadiness(
        input({
          last_local_verified_at: null,
          last_offsite_verified_at: null,
          last_restore_drill_result: null,
          last_restore_drill_duration_ms: null,
        }),
      ),
    );
    expect(g.maia_backup_age_seconds).toBeUndefined();
    expect(g.maia_restore_drill_duration_seconds).toBeUndefined();
    expect(g.maia_backup_readiness_level).toBe(2);
  });
});
