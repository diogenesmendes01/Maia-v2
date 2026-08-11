import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = sendMock;
  }
  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  class DeleteObjectsCommand {
    constructor(public input: unknown) {}
  }
  return { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand };
});

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => 'STREAM'),
}));
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 100 })),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let configState: Record<string, unknown> = {};
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      return configState[prop as string];
    },
  }),
}));

beforeEach(() => {
  sendMock.mockReset();
  configState = {
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_S3_PREFIX: 'maia',
    BACKUP_RETENTION_CLOUD_DAYS: 30,
  };
});

describe('isS3Configured', () => {
  it('false when bucket is unset', async () => {
    configState.BACKUP_S3_BUCKET = undefined;
    vi.resetModules();
    const { isS3Configured } = await import('../../src/workers/backup-s3.js');
    expect(isS3Configured()).toBe(false);
  });

  it('true when bucket is set', async () => {
    vi.resetModules();
    const { isS3Configured } = await import('../../src/workers/backup-s3.js');
    expect(isS3Configured()).toBe(true);
  });
});

describe('uploadBackup', () => {
  it('calls PutObject with the right bucket + key', async () => {
    sendMock.mockResolvedValue({});
    vi.resetModules();
    const { uploadBackup, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    const url = await uploadBackup('/tmp/maia-2026-05-08T03-00-00.dump');
    expect(sendMock).toHaveBeenCalledOnce();
    const cmd = sendMock.mock.calls[0]![0];
    expect(cmd.input.Bucket).toBe('maia-backups');
    expect(cmd.input.Key).toBe('maia/maia-2026-05-08T03-00-00.dump');
    expect(url).toContain('maia-backups');
    expect(url).toContain('maia/maia-2026-05-08T03-00-00.dump');
  });

  it('throws when bucket is unset', async () => {
    configState.BACKUP_S3_BUCKET = undefined;
    vi.resetModules();
    const { uploadBackup } = await import('../../src/workers/backup-s3.js');
    await expect(uploadBackup('/tmp/x.dump')).rejects.toThrow(/BACKUP_S3_BUCKET/);
  });

  it('uses custom endpoint in returned URL when configured (B2/R2)', async () => {
    configState.BACKUP_S3_ENDPOINT = 'https://s3.us-west-002.backblazeb2.com';
    sendMock.mockResolvedValue({});
    vi.resetModules();
    const { uploadBackup, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    const url = await uploadBackup('/tmp/x.dump');
    expect(url).toContain('backblazeb2.com');
  });
});

/**
 * `pruneCloud` was REMOVED in the #520 round-1 P1 fix, and its tests with it.
 *
 * It selected objects to DELETE by `LastModified`, so an artifact under legal
 * hold was destroyed if it was simply old enough; it swallowed a per-chunk
 * delete failure; and it returned a partial count the caller audited as
 * `completed`. Tests that asserted "deletes objects older than the retention
 * window" were therefore pinning the defect in place.
 *
 * Deletion now lives in `src/ops/backup/retention.ts`, driven by
 * `backup_runs` + `backup_manifests` with a legal-hold gate and a confirmation
 * per object (`tests/unit/ops/backup-retention.spec.ts`). What remains here is
 * the LISTING, which only feeds reconciliation and never deletes.
 */
describe('listBackupObjectKeys', () => {
  it('returns the keys under the backup prefix', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: 'maia/a.dump' }, { Key: 'maia/b.dump' }],
      IsTruncated: false,
    });
    vi.resetModules();
    const { listBackupObjectKeys, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    expect(await listBackupObjectKeys()).toEqual(['maia/a.dump', 'maia/b.dump']);
  });

  it('iterates pagination via ContinuationToken', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'maia/a.dump' }],
        IsTruncated: true,
        NextContinuationToken: 'tok2',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'maia/b.dump' }], IsTruncated: false });
    vi.resetModules();
    const { listBackupObjectKeys, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    expect(await listBackupObjectKeys()).toEqual(['maia/a.dump', 'maia/b.dump']);
  });

  it('returns nothing — and calls nothing — when the bucket is unset', async () => {
    configState.BACKUP_S3_BUCKET = undefined;
    vi.resetModules();
    const { listBackupObjectKeys } = await import('../../src/workers/backup-s3.js');
    expect(await listBackupObjectKeys()).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never deletes — listing is for reconciliation only', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [{ Key: 'maia/a.dump' }], IsTruncated: false });
    vi.resetModules();
    const { listBackupObjectKeys, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    await listBackupObjectKeys();
    // Exactly one call: the list. No DeleteObjects.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
