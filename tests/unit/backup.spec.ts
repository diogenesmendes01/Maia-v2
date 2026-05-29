import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

// nightly_backup + cloud_backup_rotation workers (issue #323 phase 2). Both are
// GENUINELY GLOBAL: `pg_dump` dumps the whole DB, `pruneCloud` only touches the
// S3 bucket, and the only DB writes are ownerless `backup_*` audit rows (the
// watcher keys them by `acao`, not tenant). They were re-homed from the legacy
// `default/default` literal to the reserved `system` sentinel. These tests mock
// the collaborators and capture the live ALS context to prove the wrapper.

const spawnMock = vi.fn();
const auditMock = vi.fn().mockResolvedValue(undefined);
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const isS3ConfiguredMock = vi.fn();
const uploadBackupMock = vi.fn();
const pruneCloudMock = vi.fn();

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 123, mtimeMs: Date.now() })),
  rmSync: vi.fn(),
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/workers/backup-s3.js', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadBackup: uploadBackupMock,
  pruneCloud: pruneCloudMock,
}));
vi.mock('../../src/config/env.js', () => ({
  config: {
    BACKUP_DIR: '/tmp/maia-backups',
    DATABASE_URL: 'postgres://localhost/maia',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
  },
}));

// A spawn() stub that resolves the pg_dump promise with a clean exit code 0.
function spawnSuccess(): unknown {
  return {
    stderr: { on: vi.fn() },
    on: (event: string, cb: (arg?: unknown) => void) => {
      if (event === 'close') cb(0);
    },
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  auditMock.mockClear();
  sendAlertMock.mockClear();
  isS3ConfiguredMock.mockReset();
  uploadBackupMock.mockReset();
  pruneCloudMock.mockReset();
});

describe('nightly_backup worker', () => {
  it('audits backup_completed after a successful pg_dump (local-only)', async () => {
    spawnMock.mockImplementation(() => spawnSuccess());
    isS3ConfiguredMock.mockReturnValue(false);
    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe('pg_dump');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'backup_completed' }),
    );
  });

  it('runs under the reserved system context (not default/default)', async () => {
    spawnMock.mockImplementation(() => spawnSuccess());
    isS3ConfiguredMock.mockReturnValue(false);
    let observed: { tenant_id: string; agent_id: string } | null = null;
    auditMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
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
