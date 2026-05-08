import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

/**
 * S3 / S3-compatible cloud backup helpers. AWS S3, Backblaze B2, Cloudflare
 * R2, Wasabi all speak the same protocol — point `BACKUP_S3_ENDPOINT` at the
 * provider's URL (B2 / R2 / Wasabi) or leave unset for AWS native.
 *
 * Configuration is intentionally permissive: an empty config means "skip
 * upload, log a warning". A bucket without credentials means "fail loudly so
 * the operator notices".
 */

let cachedClient: S3Client | null = null;

export function isS3Configured(): boolean {
  return Boolean(config.BACKUP_S3_BUCKET);
}

function getS3Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: config.BACKUP_S3_REGION,
    endpoint: config.BACKUP_S3_ENDPOINT,
    // S3-compatible providers (B2, R2, Wasabi) require path-style addressing.
    // AWS native works either way; pick path-style for portability.
    forcePathStyle: Boolean(config.BACKUP_S3_ENDPOINT),
    credentials:
      config.BACKUP_S3_ACCESS_KEY && config.BACKUP_S3_SECRET_KEY
        ? {
            accessKeyId: config.BACKUP_S3_ACCESS_KEY,
            secretAccessKey: config.BACKUP_S3_SECRET_KEY,
          }
        : undefined,
  });
  return cachedClient;
}

/**
 * Upload a local backup file to S3 / S3-compatible storage. Returns the
 * remote URL on success. Throws on failure — caller decides whether to
 * propagate or just log.
 */
export async function uploadBackup(localPath: string): Promise<string> {
  if (!config.BACKUP_S3_BUCKET) {
    throw new Error('BACKUP_S3_BUCKET not set');
  }
  const stats = await stat(localPath);
  const key = `${config.BACKUP_S3_PREFIX}/${basename(localPath)}`;
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: config.BACKUP_S3_BUCKET,
      Key: key,
      Body: createReadStream(localPath),
      ContentLength: stats.size,
      ContentType: 'application/octet-stream',
    }),
  );
  const endpoint = config.BACKUP_S3_ENDPOINT ?? 's3.amazonaws.com';
  return `${endpoint.replace(/\/$/, '')}/${config.BACKUP_S3_BUCKET}/${key}`;
}

/**
 * Walk the bucket prefix and delete dumps older than
 * `BACKUP_RETENTION_CLOUD_DAYS`. No-op if S3 isn't configured. Errors are
 * logged and counted but never thrown — backup retention is best-effort.
 *
 * Returns `{ scanned, deleted }` so the caller can audit a meaningful number.
 */
export async function pruneCloud(): Promise<{ scanned: number; deleted: number }> {
  if (!config.BACKUP_S3_BUCKET) return { scanned: 0, deleted: 0 };
  const cutoff = Date.now() - config.BACKUP_RETENTION_CLOUD_DAYS * 86_400_000;
  const client = getS3Client();
  let scanned = 0;
  const keysToDelete: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listRes: import('@aws-sdk/client-s3').ListObjectsV2CommandOutput =
      await client.send(
        new ListObjectsV2Command({
          Bucket: config.BACKUP_S3_BUCKET,
          Prefix: `${config.BACKUP_S3_PREFIX}/`,
          ContinuationToken: continuationToken,
        }),
      );
    for (const obj of listRes.Contents ?? []) {
      scanned += 1;
      const lastModified = obj.LastModified?.getTime() ?? 0;
      if (obj.Key && lastModified < cutoff) {
        keysToDelete.push(obj.Key);
      }
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);
  if (keysToDelete.length === 0) return { scanned, deleted: 0 };
  // S3 DeleteObjects accepts up to 1000 keys per request; chunk defensively.
  let deleted = 0;
  for (let i = 0; i < keysToDelete.length; i += 1000) {
    const chunk = keysToDelete.slice(i, i + 1000);
    try {
      const res = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.BACKUP_S3_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
      deleted += res.Deleted?.length ?? 0;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, chunk_size: chunk.length },
        'backup.cloud_prune_chunk_failed',
      );
    }
  }
  return { scanned, deleted };
}

/** Test-only: reset the cached client between specs. */
export function _resetS3ClientForTests(): void {
  cachedClient = null;
}
