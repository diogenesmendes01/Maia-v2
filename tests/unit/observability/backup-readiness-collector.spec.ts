/**
 * Issue #536 — the restore-drill gate as a scraped signal.
 *
 * `evaluateBackupReadiness` graded drill age since #520 and had ZERO production
 * callers: the verdict existed and nothing ever asked for it. These tests hold
 * the wiring that makes it a gate — the series is registered on the REAL metric
 * registry and rendered by the REAL `/metrics` renderer, so a scrape shows the
 * verdict even if the drill worker never runs again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetBackupReadinessCollectorForTests,
  backupReadinessGaugeSnapshot,
  registerBackupReadinessGauges,
  type BackupReadinessCollectorDeps,
} from '../../../src/observability/backup-readiness-collector.js';
import { renderPrometheus } from '../../../src/lib/metrics.js';
import {
  resolveBackupProfile,
  type BackupConfigInput,
} from '../../../src/ops/backup/profile.js';
import type { DrillEvidenceFacts } from '../../../src/ops/backup/drill-schedule.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const HOURS = 3_600_000;
const INTERVAL_HOURS = 168;

function prodProfile(over: Partial<BackupConfigInput> = {}) {
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
    BACKUP_DUMP_TIMEOUT_MS: 1000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1000,
    BACKUP_RESTORE_TIMEOUT_MS: 1000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: INTERVAL_HOURS,
    RETENTION_DRY_RUN: true,
    ...over,
  });
}

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

function deps(over: Partial<DrillEvidenceFacts> | Error = {}): BackupReadinessCollectorDeps {
  return {
    now: () => NOW,
    resolveProfile: () => prodProfile(),
    readFacts: async () => {
      if (over instanceof Error) throw over;
      return facts(over);
    },
  };
}

beforeEach(() => {
  _resetBackupReadinessCollectorForTests();
});

describe('maia_restore_drill_check_level — the gate', () => {
  it('is 0 while a recent drill proves an artifact restorable', async () => {
    const g = await backupReadinessGaugeSnapshot(deps());
    expect(g.maia_restore_drill_check_level).toBe(0);
    expect(g.maia_restore_drill_age_seconds).toBe(24 * 3600);
  });

  it('is 2 once the evidence is older than the interval', async () => {
    const g = await backupReadinessGaugeSnapshot(
      deps({ last_restore_drill_at: new Date(NOW.getTime() - (INTERVAL_HOURS + 1) * HOURS) }),
    );
    expect(g.maia_restore_drill_check_level).toBe(2);
  });

  it('is 2 when NO drill has ever run — absence is not evidence of success', async () => {
    const g = await backupReadinessGaugeSnapshot(
      deps({
        last_restore_drill_at: null,
        last_restore_drill_result: null,
        last_restore_drill_duration_ms: null,
        last_restore_drill_cleanup_status: null,
      }),
    );
    expect(g.maia_restore_drill_check_level).toBe(2);
    // Never measured: no age series rather than a sentinel that would read as
    // either "just drilled" or "drilled long ago".
    expect(g.maia_restore_drill_age_seconds).toBeUndefined();
  });

  it('is 2 when the last drill FAILED, however recent', async () => {
    const g = await backupReadinessGaugeSnapshot(
      deps({
        last_restore_drill_at: new Date(NOW.getTime() - 1 * HOURS),
        last_restore_drill_result: 'failed',
      }),
    );
    expect(g.maia_restore_drill_check_level).toBe(2);
  });

  it('is 2 — never the last known-good value — when the evidence cannot be read', async () => {
    const ok = await backupReadinessGaugeSnapshot(deps());
    expect(ok.maia_restore_drill_check_level).toBe(0);

    _resetBackupReadinessCollectorForTests();
    const g = await backupReadinessGaugeSnapshot(deps(new Error('connection terminated')));
    expect(g.maia_restore_drill_check_level).toBe(2);
    expect(g.maia_backup_readiness_level).toBe(2);
  });

  it('never leaks a connection URL when the read fails', async () => {
    // The collector logs the failure; the message a driver throws can carry
    // DATABASE_URL with the password (issue #520's real leak).
    const { logger } = await import('../../../src/lib/logger.js');
    const seen: unknown[] = [];
    const original = logger.warn.bind(logger);
    (logger as unknown as { warn: unknown }).warn = (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    };
    try {
      await backupReadinessGaugeSnapshot(
        deps(new Error('postgres://maia:sup3rs3cr3t@db.internal:5432/maia_prod is unreachable')),
      );
    } finally {
      (logger as unknown as { warn: unknown }).warn = original;
    }
    const body = JSON.stringify(seen);
    expect(body).not.toContain('sup3rs3cr3t');
    expect(body).toContain('[redacted]');
  });
});

describe('the gauge is actually registered on /metrics', () => {
  it('renders the gate series through the real Prometheus renderer', async () => {
    registerBackupReadinessGauges(
      deps({ last_restore_drill_at: new Date(NOW.getTime() - (INTERVAL_HOURS + 1) * HOURS) }),
    );
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_restore_drill_check_level 2$/m);
    // Always emitted, so an alert can be written against the value rather than
    // against `absent()` — a missing series is ambiguous.
    expect(body).toMatch(/^maia_backup_readiness_level \d$/m);
  });

  /**
   * ANTI-MIRROR-TRAP. The test above registers the collector itself, so it
   * would keep passing if the production wiring were deleted. This one goes
   * through `registerRuntimeObservability()` — the single wiring point
   * `server.ts` calls at boot — and asserts the gate series exists afterwards.
   * Remove the call from `src/observability/register.ts` and this fails.
   *
   * Robust with or without a database: the provider never throws, and a failed
   * evidence read produces the pessimistic value rather than no series.
   */
  it('is wired from registerRuntimeObservability, the boot-time registration point', async () => {
    const { registerRuntimeObservability } = await import(
      '../../../src/observability/register.js'
    );
    await registerRuntimeObservability();
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_restore_drill_check_level \d$/m);
  }, 30_000);
});
