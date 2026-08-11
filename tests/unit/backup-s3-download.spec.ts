import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Issue #536 §1, round-2 review of PR #541, finding #1 — the staging half.
 *
 * `downloadBackupObjectToFile` streams a production artifact onto the host. It
 * used to throw on a broken transfer WITHOUT touching the destination, so the
 * partial dump stayed there. Combined with a drill that only registered the
 * destination after the download RETURNED, that residue was invisible to the
 * teardown and the drill certified `cleanup_status='clean'` over it.
 *
 * A separate spec file from `backup-s3.spec.ts` on purpose: that one mocks
 * `node:fs` and `node:fs/promises` wholesale, and this behaviour is only real
 * against a real filesystem — the question is literally "is the file still
 * there?".
 */
const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = sendMock;
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
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
  class HeadObjectCommand {
    constructor(public input: unknown) {}
  }
  return {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    HeadObjectCommand,
  };
});

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

import { downloadBackupObjectToFile } from '../../src/workers/backup-s3.js';

const dir = mkdtempSync(join(tmpdir(), 'maia-s3-download-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dest = (): string => join(dir, `${randomUUID()}.artifact`);

beforeEach(() => {
  sendMock.mockReset();
  configState = {
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_S3_PREFIX: 'maia',
  };
});

/** A body that delivers real bytes and then dies, like a reset connection. */
function dyingStream(chunk: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(chunk);
        return;
      }
      this.destroy(new Error('ECONNRESET'));
    },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('downloadBackupObjectToFile', () => {
  it('streams the object to disk and digests what actually LANDED', async () => {
    const body = Buffer.from('maia backup artifact bytes');
    sendMock.mockResolvedValue({ Body: Readable.from([body]) });
    const path = dest();

    const out = await downloadBackupObjectToFile('maia/artifact.dump', path);

    expect(out.bytes).toBe(body.length);
    expect(out.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(await readFile(path)).toEqual(body);
  });

  it('removes the partial artifact when the stream dies AFTER writing bytes', async () => {
    // 256 KiB is well past the write stream's high-water mark, so bytes are on
    // disk before the reset — this is the case that used to leave a truncated
    // production dump on the host.
    sendMock.mockResolvedValue({
      Body: dyingStream(Buffer.alloc(256 * 1024, 7)),
    });
    const path = dest();

    await expect(downloadBackupObjectToFile('maia/artifact.dump', path)).rejects.toMatchObject({
      code: 'artifact_fetch_failed',
    });
    expect(await exists(path)).toBe(false);
  });

  it('leaves nothing behind when the transfer dies before any byte lands', async () => {
    // `createWriteStream` creates the destination at OPEN, so even an
    // immediately-failing transfer used to leave an empty file at a path
    // nobody was tracking.
    sendMock.mockResolvedValue({
      Body: new Readable({
        read() {
          this.destroy(new Error('ECONNRESET'));
        },
      }),
    });
    const path = dest();

    await expect(downloadBackupObjectToFile('maia/artifact.dump', path)).rejects.toMatchObject({
      code: 'artifact_fetch_failed',
    });
    expect(await exists(path)).toBe(false);
  });

  it('NEVER deletes bytes the `wx` flag refused to overwrite', async () => {
    // EEXIST is the one failure whose destination is not ours: `wx` refused to
    // open a file that was already there — a concurrent writer, or a stale
    // artifact an operator is mid-triage on. Sweeping it would be this function
    // destroying exactly what `wx` exists to protect.
    const path = dest();
    await writeFile(path, 'somebody-elses-bytes');
    sendMock.mockResolvedValue({
      Body: Readable.from([Buffer.from('new bytes')]),
    });

    await expect(downloadBackupObjectToFile('maia/artifact.dump', path)).rejects.toMatchObject({
      code: 'artifact_fetch_failed',
    });
    expect(await readFile(path, 'utf8')).toBe('somebody-elses-bytes');
  });

  it('refuses without an off-site destination configured', async () => {
    configState.BACKUP_S3_BUCKET = undefined;
    await expect(downloadBackupObjectToFile('k', dest())).rejects.toMatchObject({
      code: 'artifact_fetch_failed',
    });
  });
});
