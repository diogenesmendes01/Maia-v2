/**
 * Thin wrapper around `@aws-sdk/client-s3` for nightly Postgres dumps.
 *
 * Supports any S3-compatible endpoint (AWS S3, Backblaze B2, Cloudflare R2,
 * Wasabi). Custom endpoints automatically use path-style addressing — required
 * by B2 and R2.
 *
 * The client is lazy-initialised so importing this module is free when
 * `BACKUP_S3_BUCKET` is unset (e.g. in tests, dev). Callers should already
 * gate on `config.BACKUP_S3_BUCKET` before invoking these functions; the
 * helpers themselves throw if the bucket isn't configured.
 */
import { createReadStream, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '@/config/env.js';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  if (!config.BACKUP_S3_ACCESS_KEY || !config.BACKUP_S3_SECRET_KEY) {
    throw new Error('s3-backup: BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY required');
  }
  cachedClient = new S3Client({
    region: config.BACKUP_S3_REGION,
    endpoint: config.BACKUP_S3_ENDPOINT,
    // Path-style is mandatory for B2/R2/Wasabi; harmless for AWS S3 with custom
    // endpoints. Skip when no endpoint is set so AWS S3 uses virtual-host style.
    forcePathStyle: Boolean(config.BACKUP_S3_ENDPOINT),
    credentials: {
      accessKeyId: config.BACKUP_S3_ACCESS_KEY,
      secretAccessKey: config.BACKUP_S3_SECRET_KEY,
    },
  });
  return cachedClient;
}

/**
 * Reset the cached client. Used by tests; not part of the public API for
 * production code.
 */
export function _resetClientForTests(): void {
  cachedClient = null;
}

function requireBucket(): string {
  const bucket = config.BACKUP_S3_BUCKET;
  if (!bucket) {
    throw new Error('s3-backup: BACKUP_S3_BUCKET not configured');
  }
  return bucket;
}

/**
 * Upload a local file to the configured bucket and return an `s3://` URI.
 */
export async function uploadBackup(localPath: string, key: string): Promise<string> {
  const bucket = requireBucket();
  const client = getClient();
  const size = statSync(localPath).size;
  const body = createReadStream(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: size,
    }),
  );
  return `s3://${bucket}/${key}`;
}

export type S3BackupEntry = { key: string; lastModified: Date };

/**
 * List backup objects under a prefix. Walks pagination tokens until exhausted.
 */
export async function listBackups(prefix: string): Promise<S3BackupEntry[]> {
  const bucket = requireBucket();
  const client = getClient();
  const out: S3BackupEntry[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      out.push({
        key: obj.Key,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteBackup(key: string): Promise<void> {
  const bucket = requireBucket();
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Download an object to a local path (used by the restore drill --from-s3).
 */
export async function downloadBackup(key: string, localPath: string): Promise<void> {
  const bucket = requireBucket();
  const client = getClient();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body) {
    throw new Error(`s3-backup: empty body for ${key}`);
  }
  // Body is a Readable in Node runtime
  const stream = body as Readable;
  await pipeline(stream, createWriteStream(localPath));
}
