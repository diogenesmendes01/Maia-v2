import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { TypedError } from '@/lib/utils.js';
import { hexToBase64, type RemoteHead } from '@/ops/backup/remote-verify.js';

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
 * Issue #520 §4/§6 — upload with PROVIDER-VERIFIED integrity, and read it back.
 *
 * ROUND-1 REVIEW FINDING (P1). The first version stamped the SHA-256 into user
 * metadata and read that same stamp back with `HEAD`. Metadata is stored BESIDE
 * the object, not derived from it, so a rotted object still reported a matching
 * "remote checksum" and the run was marked verified. The check could not fail
 * for the reason it existed.
 *
 * What actually verifies:
 *
 *  - `uploadBackupObject` sends `ChecksumAlgorithm: SHA256` + the expected
 *    `ChecksumSHA256`. S3 (and every provider that implements the flexible
 *    checksum API) VALIDATES it against the received bytes and REJECTS a
 *    mismatched upload — so a corrupted transfer never becomes an object.
 *  - `headBackupObject` asks for `ChecksumMode: ENABLED`, which returns the
 *    digest the provider computed over what it stored. That is evidence.
 *  - `downloadAndDigestBackupObject` is the fallback for providers that
 *    implement neither: stream the object back and recompute locally.
 *
 * The user-metadata stamp is still written and still returned, but ONLY as a
 * diagnostic label — `src/ops/backup/remote-verify.ts` never reads it when
 * deciding, and a test proves a matching stamp over corrupted bytes fails.
 *
 * A multipart ETag is NOT a content hash and is deliberately never used as a
 * substitute (issue §3).
 *
 * Provider-side controls the application cannot set portably — SSE-KMS key
 * policy, bucket versioning, object lock — remain the operator's bucket
 * configuration (issue §6). The artifact itself is already encrypted
 * client-side before it reaches this module, so a provider that ignores SSE
 * still never receives plaintext.
 */
/**
 * The object key an artifact will occupy. Exposed so the caller knows the key
 * BEFORE uploading — which is what lets a cancelled upload reap its own
 * possible leftover (issue #520 round-1 P2).
 */
export function backupObjectKey(localPath: string): string {
  return `${config.BACKUP_S3_PREFIX}/${basename(localPath)}`;
}

/** Delete one backup object. Used to reap the leftover of a cancelled upload. */
export async function deleteBackupObject(key: string): Promise<void> {
  if (!config.BACKUP_S3_BUCKET) return;
  await getS3Client().send(
    new DeleteObjectsCommand({
      Bucket: config.BACKUP_S3_BUCKET,
      Delete: { Objects: [{ Key: key }] },
    }),
  );
}

export async function uploadBackupObject(
  localPath: string,
  sha256Hex: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ bucket: string; key: string }> {
  if (!config.BACKUP_S3_BUCKET) {
    throw new Error('BACKUP_S3_BUCKET not set');
  }
  const stats = await stat(localPath);
  const key = backupObjectKey(localPath);
  const body = createReadStream(localPath);
  // Abort must tear the source stream down too, or the file handle outlives
  // the cancelled request (issue #520 round-1 P2).
  const onAbort = () => body.destroy(new Error('upload aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.BACKUP_S3_BUCKET,
        Key: key,
        Body: body,
        ContentLength: stats.size,
        ContentType: 'application/octet-stream',
        // The provider validates this against the bytes it receives.
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: hexToBase64(sha256Hex),
        // Diagnostic only — never used as verification evidence.
        Metadata: { 'maia-sha256': sha256Hex },
      }),
      { abortSignal: options.signal },
    );
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (!body.destroyed) body.destroy();
  }
  return { bucket: config.BACKUP_S3_BUCKET, key };
}

/**
 * Read the destination's own view of the object: size, the digest the PROVIDER
 * computed over the stored bytes, and (diagnostically) the uploader's stamp.
 * `null` when the object is missing or unreadable.
 */
export async function headBackupObject(key: string): Promise<RemoteHead | null> {
  if (!config.BACKUP_S3_BUCKET) return null;
  try {
    const res = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: config.BACKUP_S3_BUCKET,
        Key: key,
        // Without this the provider does not return ChecksumSHA256 at all.
        ChecksumMode: 'ENABLED',
      }),
    );
    return {
      bytes: res.ContentLength ?? null,
      providerSha256Base64: res.ChecksumSHA256 ?? null,
      metadataSha256Hex: res.Metadata?.['maia-sha256'] ?? null,
    };
  } catch {
    // A missing/unreadable object is a verification FAILURE, not an exception
    // the caller must special-case — it returns null and the run degrades/fails.
    return null;
  }
}

/**
 * Stream the stored object back and recompute its digest locally.
 *
 * The fallback for S3-compatible providers that do not implement the flexible
 * checksum API (some B2 / R2 / Wasabi configurations). Costs a full egress, so
 * the caller decides when it is warranted — but it is the only remaining way to
 * prove the STORED bytes are the ones we produced.
 */
export async function downloadAndDigestBackupObject(
  key: string,
): Promise<{ sha256: string; bytes: number } | null> {
  if (!config.BACKUP_S3_BUCKET) return null;
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: config.BACKUP_S3_BUCKET, Key: key }),
    );
    const body = res.Body as Readable | undefined;
    if (!body) return null;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      hash.update(buf);
    }
    return { sha256: hash.digest('hex'), bytes };
  } catch {
    return null;
  }
}

/**
 * Stream a stored object to a LOCAL FILE, digesting it on the way through
 * (issue #536 §1 — the restore drill must consume the off-site copy).
 *
 * Distinct from `downloadAndDigestBackupObject`, which discards the bytes: the
 * drill needs them on disk to feed `pg_restore`. Streaming (never buffering) is
 * mandatory for the same reason it is on the upload side — a production
 * artifact is gigabytes and must not enter the heap.
 *
 * The digest returned is computed over what actually LANDED on disk, not over
 * what the provider said it would send, so a truncated transfer fails the
 * caller's manifest binding instead of reaching `pg_restore`.
 */
export async function downloadBackupObjectToFile(
  key: string,
  destPath: string,
): Promise<{ sha256: string; bytes: number }> {
  if (!config.BACKUP_S3_BUCKET) {
    throw new TypedError('artifact_fetch_failed', 'no off-site destination configured', {});
  }
  let body: Readable;
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: config.BACKUP_S3_BUCKET, Key: key }),
    );
    const stream = res.Body as Readable | undefined;
    if (!stream) {
      throw new TypedError('artifact_fetch_failed', 'destination returned an empty body', {});
    }
    body = stream;
  } catch (err) {
    // Never echo the provider error: an SDK error can carry a signed URL.
    throw new TypedError('artifact_fetch_failed', 'could not read the off-site object', {
      cause: (err as TypedError).code ?? (err as Error).name,
    });
  }

  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    // `wx` so a stale staged file is a loud failure rather than a silent
    // append onto somebody else's bytes.
    await pipeline(body, meter, createWriteStream(destPath, { flags: 'wx' }));
  } catch (err) {
    throw new TypedError('artifact_fetch_failed', 'off-site object could not be staged locally', {
      cause: (err as NodeJS.ErrnoException).code ?? (err as Error).name,
    });
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * List the object keys under the backup prefix.
 *
 * REPLACES `pruneCloud`, removed in the round-1 P1 fix. That function selected
 * objects to DELETE by `LastModified`, swallowed a per-chunk failure and
 * returned a partial count that the caller audited as `completed` — so a pass
 * could destroy an artifact under legal hold and report success for a job that
 * half-worked.
 *
 * Deletion is now planned from `backup_runs` + `backup_manifests` and executed
 * by `src/ops/backup/retention.ts`, one confirmed object at a time. This
 * listing exists only to RECONCILE: keys here with no run row are reported to
 * the operator, never deleted on a guess — an unidentified object may be
 * exactly the one somebody is holding.
 */
export async function listBackupObjectKeys(): Promise<string[]> {
  if (!config.BACKUP_S3_BUCKET) return [];
  const client = getS3Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listRes: import('@aws-sdk/client-s3').ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: config.BACKUP_S3_BUCKET,
        Prefix: `${config.BACKUP_S3_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of listRes.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Test-only: reset the cached client between specs. */
export function _resetS3ClientForTests(): void {
  cachedClient = null;
}
