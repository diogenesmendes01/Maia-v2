import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// Mock @aws-sdk/client-s3 BEFORE importing s3-backup. We capture each command's
// constructor input on the instance so the test can read it back.
const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    public input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class S3Client {
    public config: Record<string, unknown>;
    constructor(cfg: Record<string, unknown>) {
      this.config = cfg;
    }
    send = (cmd: unknown) => sendMock(cmd);
  }
  return {
    S3Client,
    PutObjectCommand: class extends FakeCommand {
      static commandName = 'PutObjectCommand';
      readonly _kind = 'PutObjectCommand';
    },
    ListObjectsV2Command: class extends FakeCommand {
      static commandName = 'ListObjectsV2Command';
      readonly _kind = 'ListObjectsV2Command';
    },
    DeleteObjectCommand: class extends FakeCommand {
      static commandName = 'DeleteObjectCommand';
      readonly _kind = 'DeleteObjectCommand';
    },
    GetObjectCommand: class extends FakeCommand {
      static commandName = 'GetObjectCommand';
      readonly _kind = 'GetObjectCommand';
    },
  };
});

vi.mock('@/config/env.js', () => ({
  config: {
    BACKUP_S3_BUCKET: 'test-bucket',
    BACKUP_S3_ACCESS_KEY: 'AKIA-test',
    BACKUP_S3_SECRET_KEY: 'secret-test',
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_S3_ENDPOINT: undefined,
  },
}));

// Stub fs.statSync used by uploadBackup so we don't need a real file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(() => ({ size: 4242 }) as unknown as ReturnType<typeof actual.statSync>),
    createReadStream: vi.fn(() => Readable.from(['payload'])),
    createWriteStream: actual.createWriteStream,
  };
});

beforeEach(() => {
  sendMock.mockReset();
  vi.resetModules();
});

describe('s3-backup', () => {
  it('uploadBackup returns s3:// URL and calls PutObjectCommand', async () => {
    sendMock.mockResolvedValue({});
    const mod = await import('../../src/lib/s3-backup.js');
    mod._resetClientForTests();

    const url = await mod.uploadBackup('/tmp/maia-test.dump', 'maia/maia-test.dump');

    expect(url).toBe('s3://test-bucket/maia/maia-test.dump');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]![0] as { _kind: string; input: Record<string, unknown> };
    expect(cmd._kind).toBe('PutObjectCommand');
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('maia/maia-test.dump');
    expect(cmd.input.ContentLength).toBe(4242);
  });

  it('uploadBackup propagates underlying SDK errors', async () => {
    sendMock.mockRejectedValue(new Error('network exploded'));
    const mod = await import('../../src/lib/s3-backup.js');
    mod._resetClientForTests();

    await expect(
      mod.uploadBackup('/tmp/maia-test.dump', 'maia/maia-test.dump'),
    ).rejects.toThrow('network exploded');
  });

  it('listBackups returns parsed list with key + lastModified', async () => {
    const lm1 = new Date('2026-04-01T03:00:00Z');
    const lm2 = new Date('2026-04-02T03:00:00Z');
    sendMock.mockResolvedValue({
      Contents: [
        { Key: 'maia/old.dump', LastModified: lm1 },
        { Key: 'maia/new.dump', LastModified: lm2 },
        { Key: undefined, LastModified: lm2 }, // skipped
      ],
      IsTruncated: false,
    });

    const mod = await import('../../src/lib/s3-backup.js');
    mod._resetClientForTests();

    const list = await mod.listBackups('maia/');
    expect(list).toEqual([
      { key: 'maia/old.dump', lastModified: lm1 },
      { key: 'maia/new.dump', lastModified: lm2 },
    ]);
    const cmd = sendMock.mock.calls[0]![0] as { _kind: string; input: Record<string, unknown> };
    expect(cmd._kind).toBe('ListObjectsV2Command');
    expect(cmd.input.Prefix).toBe('maia/');
  });

  it('listBackups paginates through ContinuationToken', async () => {
    const lm = new Date('2026-04-03T03:00:00Z');
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'maia/a.dump', LastModified: lm }],
        IsTruncated: true,
        NextContinuationToken: 'TOKEN-1',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'maia/b.dump', LastModified: lm }],
        IsTruncated: false,
      });

    const mod = await import('../../src/lib/s3-backup.js');
    mod._resetClientForTests();

    const list = await mod.listBackups('maia/');
    expect(list.map((e) => e.key)).toEqual(['maia/a.dump', 'maia/b.dump']);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const second = sendMock.mock.calls[1]![0] as { input: Record<string, unknown> };
    expect(second.input.ContinuationToken).toBe('TOKEN-1');
  });

  it('deleteBackup issues DeleteObjectCommand against the configured bucket', async () => {
    sendMock.mockResolvedValue({});
    const mod = await import('../../src/lib/s3-backup.js');
    mod._resetClientForTests();

    await mod.deleteBackup('maia/old.dump');

    const cmd = sendMock.mock.calls[0]![0] as { _kind: string; input: Record<string, unknown> };
    expect(cmd._kind).toBe('DeleteObjectCommand');
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('maia/old.dump');
  });
});
