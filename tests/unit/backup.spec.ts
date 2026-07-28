import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

/**
 * nightly_backup + cloud_backup_rotation workers.
 *
 * Two contracts are asserted here:
 *
 * 1. TENANT SCOPE (issue #323 phase 2). Both jobs are GENUINELY GLOBAL:
 *    `pg_dump` dumps the whole DB, `pruneCloud` only touches the S3 bucket, and
 *    the only DB writes are ownerless `backup_*` rows. They run under the
 *    reserved `system` sentinel, never the legacy `default/default` literal.
 *
 * 2. SHARED, LOCKED, EVIDENCE-BASED EXECUTION (issue #520). The worker no
 *    longer owns a private copy of the dump logic: it takes the global
 *    single-flight lock and delegates to `runVerifiedBackup`, the same service
 *    `scripts/backup.ts` calls. A concurrent run reports `already_running`
 *    without starting a second `pg_dump`, and a degraded/failed outcome raises
 *    an alert instead of being audited as a plain success.
 */

const auditMock = vi.fn().mockResolvedValue(undefined);
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const isS3ConfiguredMock = vi.fn();
const pruneCloudMock = vi.fn();
const runVerifiedBackupMock = vi.fn();
const withOpsLockMock = vi.fn();
const createBackupPortsMock = vi.fn(() => ({}) as never);

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 123, mtimeMs: Date.now() })),
  rmSync: vi.fn(),
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/db/client.js', () => ({ pool: {}, db: {} }));
vi.mock('../../src/workers/backup-s3.js', () => ({
  isS3Configured: isS3ConfiguredMock,
  pruneCloud: pruneCloudMock,
}));
vi.mock('../../src/ops/backup/adapters.js', () => ({
  createBackupPorts: createBackupPortsMock,
}));
vi.mock('../../src/ops/backup/service.js', () => ({
  runVerifiedBackup: runVerifiedBackupMock,
}));
vi.mock('../../src/ops/backup/single-flight.js', () => ({
  OPS_LOCK_KEYS: { backup_run: 'maia_ops_backup_run' },
  withOpsLock: withOpsLockMock,
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'development',
    BACKUP_DIR: '/tmp/maia-backups',
    DATABASE_URL: 'postgres://localhost/maia',
    BACKUP_ENABLED: true,
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
    BACKUP_DUMP_TIMEOUT_MS: 3_600_000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1_800_000,
    BACKUP_RESTORE_TIMEOUT_MS: 3_600_000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
  },
}));

function lockRuns(): void {
  withOpsLockMock.mockImplementation(
    async (_key: string, _deps: unknown, fn: () => Promise<unknown>) => ({
      status: 'ran',
      result: await fn(),
    }),
  );
}

function backupResult(over: Record<string, unknown> = {}) {
  return {
    backup_id: 'b-1',
    correlation_id: 'c-1',
    outcome: 'completed',
    reason: 'ok',
    artifact_ref: 'maia-2026-07-28T03-00-00.dump',
    state: 'completed',
    ...over,
  };
}

beforeEach(() => {
  auditMock.mockClear();
  sendAlertMock.mockClear();
  isS3ConfiguredMock.mockReset();
  pruneCloudMock.mockReset();
  runVerifiedBackupMock.mockReset();
  withOpsLockMock.mockReset();
  runVerifiedBackupMock.mockResolvedValue(backupResult());
  lockRuns();
});

describe('nightly_backup worker', () => {
  it('delegates to the shared verified-backup service (no private dump logic)', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(runVerifiedBackupMock).toHaveBeenCalledTimes(1);
    expect(runVerifiedBackupMock.mock.calls[0]![2]).toBe('schedule');
  });

  it('runs under the global single-flight lock', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(withOpsLockMock).toHaveBeenCalledWith(
      'maia_ops_backup_run',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('starts NO second dump when another runner holds the lock', async () => {
    withOpsLockMock.mockResolvedValue({ status: 'already_running' });
    const { executeBackup } = await import('../../src/workers/backup.js');
    const res = await executeBackup('cli');
    expect(res.status).toBe('already_running');
    expect(runVerifiedBackupMock).not.toHaveBeenCalled();
  });

  it('does not alert on a fully verified run', async () => {
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('alerts on a DEGRADED run (local-only is not a normal success)', async () => {
    runVerifiedBackupMock.mockResolvedValue(
      backupResult({ outcome: 'completed_degraded', reason: 'offsite_not_configured' }),
    );
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('DEGRADED') }),
    );
  });

  it('alerts on a FAILED run', async () => {
    runVerifiedBackupMock.mockResolvedValue(
      backupResult({ outcome: 'failed', reason: 'catalog_unreadable' }),
    );
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    expect(sendAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('FAILED') }),
    );
  });

  it('never puts a path, URL or credential in the alert body', async () => {
    runVerifiedBackupMock.mockResolvedValue(backupResult({ outcome: 'failed', reason: 'dump_failed' }));
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();
    const body = sendAlertMock.mock.calls[0]![0].body as string;
    expect(body).not.toMatch(/postgres:\/\//);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain('/tmp/maia-backups');
  });

  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    runVerifiedBackupMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return backupResult();
    });
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});

describe('cloud_backup_rotation worker', () => {
  it('prunes cloud backups and audits the rotation result', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    pruneCloudMock.mockResolvedValue({ scanned: 5, deleted: 2 });
    const { runCloudBackupRotation } = await import('../../src/workers/backup.js');
    await runCloudBackupRotation();

    expect(pruneCloudMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'backup_cloud_rotation_completed',
        metadata: expect.objectContaining({ scanned: 5, deleted: 2 }),
      }),
    );
  });

  it('skips and never opens the context-consuming path when S3 is unconfigured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { runCloudBackupRotation } = await import('../../src/workers/backup.js');
    await runCloudBackupRotation();

    expect(pruneCloudMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('runs under the reserved system context (not default/default)', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    let observed: { tenant_id: string; agent_id: string } | null = null;
    pruneCloudMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return { scanned: 0, deleted: 0 };
    });
    const { runCloudBackupRotation } = await import('../../src/workers/backup.js');
    await runCloudBackupRotation();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});
