import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const auditMock = vi.fn().mockResolvedValue(undefined);
const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const uploadBackupMock = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('@/lib/s3-backup.js', () => ({ uploadBackup: uploadBackupMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

// Stub child_process.spawn so the test never invokes a real pg_dump.
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdout: EventEmitter;
      };
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      // Resolve on next tick with exit code 0
      setImmediate(() => proc.emit('close', 0));
      return proc;
    }),
  };
});

// Stub fs to avoid touching the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 9001, mtimeMs: Date.now() }) as unknown as ReturnType<
      typeof actual.statSync
    >),
    rmSync: vi.fn(),
  };
});

// Default config: S3 bucket configured. Individual tests override via
// vi.doMock + vi.resetModules.
function mockConfig(overrides: Record<string, unknown> = {}) {
  vi.doMock('@/config/env.js', () => ({
    config: {
      BACKUP_DIR: '/tmp/backups',
      BACKUP_RETENTION_LOCAL_DAYS: 7,
      BACKUP_RETENTION_CLOUD_DAYS: 30,
      BACKUP_S3_BUCKET: 'test-bucket',
      BACKUP_S3_ACCESS_KEY: 'AKIA-test',
      BACKUP_S3_SECRET_KEY: 'secret-test',
      BACKUP_S3_REGION: 'us-east-1',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      ...overrides,
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
  auditMock.mockClear();
  sendAlertMock.mockClear();
  uploadBackupMock.mockReset();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
});

describe('runNightlyBackup S3 integration', () => {
  it('case 1: bucket set + upload OK -> backup_completed includes s3_url', async () => {
    mockConfig();
    uploadBackupMock.mockResolvedValue('s3://test-bucket/maia/dump.dump');

    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    expect(uploadBackupMock).toHaveBeenCalledTimes(1);
    const completedCall = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_completed',
    );
    expect(completedCall).toBeDefined();
    const meta = (completedCall![0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.s3_url).toBe('s3://test-bucket/maia/dump.dump');
    expect(meta.size_bytes).toBe(9001);

    // No S3-failure audit
    const failed = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_s3_upload_failed',
    );
    expect(failed).toBeUndefined();
  });

  it('case 2: bucket set + upload FAIL -> backup_s3_upload_failed emitted, backup_completed still ok without s3_url', async () => {
    mockConfig();
    uploadBackupMock.mockRejectedValue(new Error('B2 503'));

    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    const failed = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_s3_upload_failed',
    );
    expect(failed).toBeDefined();
    expect(
      (failed![0] as { metadata: Record<string, unknown> }).metadata.error,
    ).toBe('B2 503');

    const completedCall = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_completed',
    );
    expect(completedCall).toBeDefined();
    const meta = (completedCall![0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.s3_url).toBeUndefined();
    // Local backup still considered successful — no backup_failed
    const fatal = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_failed',
    );
    expect(fatal).toBeUndefined();
  });

  it('case 3: bucket unset -> upload skipped silently, backup_completed without s3_url', async () => {
    mockConfig({ BACKUP_S3_BUCKET: undefined, BACKUP_S3_ACCESS_KEY: undefined });

    const { runNightlyBackup } = await import('../../src/workers/backup.js');
    await runNightlyBackup();

    expect(uploadBackupMock).not.toHaveBeenCalled();
    const completedCall = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_completed',
    );
    expect(completedCall).toBeDefined();
    const meta = (completedCall![0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.s3_url).toBeUndefined();
    const failed = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'backup_s3_upload_failed',
    );
    expect(failed).toBeUndefined();
  });
});
