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

describe('pruneCloud', () => {
  it('deletes objects older than retention window', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000); // 60d old
    const fresh = new Date(Date.now() - 1 * 86_400_000); // 1d old
    sendMock
      // ListObjectsV2 page 1 (final)
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'maia/old-1.dump', LastModified: old },
          { Key: 'maia/fresh-1.dump', LastModified: fresh },
          { Key: 'maia/old-2.dump', LastModified: old },
        ],
        IsTruncated: false,
      })
      // DeleteObjects
      .mockResolvedValueOnce({
        Deleted: [{ Key: 'maia/old-1.dump' }, { Key: 'maia/old-2.dump' }],
      });
    vi.resetModules();
    const { pruneCloud, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    const out = await pruneCloud();
    expect(out.scanned).toBe(3);
    expect(out.deleted).toBe(2);
    // 2 calls: list + delete
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns zero counts when bucket is unset', async () => {
    configState.BACKUP_S3_BUCKET = undefined;
    vi.resetModules();
    const { pruneCloud } = await import('../../src/workers/backup-s3.js');
    expect(await pruneCloud()).toEqual({ scanned: 0, deleted: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('iterates pagination via ContinuationToken', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'maia/a.dump', LastModified: old }],
        IsTruncated: true,
        NextContinuationToken: 'tok2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'maia/b.dump', LastModified: old }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Deleted: [{ Key: 'maia/a.dump' }, { Key: 'maia/b.dump' }],
      });
    vi.resetModules();
    const { pruneCloud, _resetS3ClientForTests } = await import(
      '../../src/workers/backup-s3.js'
    );
    _resetS3ClientForTests();
    const out = await pruneCloud();
    expect(out.scanned).toBe(2);
    expect(out.deleted).toBe(2);
  });
});
