/**
 * P10b — Debug-mode encrypted snapshot to S3 (or inline fallback).
 *
 * When redaction_class='debug', the body bypasses the standard PII
 * stripper and is instead AES-256-GCM encrypted and uploaded to S3
 * with a 24h TTL. Reads require MFA-gated admin role (enforced by the
 * Admin UI, not here).
 *
 * The ciphertext envelope (iv/tag/key_version) is always stored in the
 * body row metadata. The CIPHERTEXT BYTES are stored in one of two ways
 * (Codex review #102 — issue 3):
 *
 *   1. `s3_uri` mode  — bucket configured (prod path). We perform a real
 *                       PutObject and only return success after the upload
 *                       lands. The body row records `s3_uri` + `encrypted=true`.
 *   2. `inline` mode  — no bucket (dev/test/CI). We return the raw
 *                       base64 ciphertext so the caller can persist it
 *                       inline in `runtime_trace_bodies.ciphertext_inline`.
 *                       Body row records `ciphertext_inline` + `encrypted=true`.
 *
 * In neither path do we mark the body persisted while the bytes are
 * unrecoverable — the previous behaviour returned a synthetic s3:// URI
 * without actually uploading, which silently destroyed evidence.
 *
 * Key management:
 *   - RUNTIME_TRACE_DEBUG_AES_KEY: base64-encoded 32-byte master key.
 *   - In prod, the master is sourced from KMS at boot and cached.
 *   - Per-tenant per-trace, we derive a unique IV (12 bytes random).
 *   - Same `hmac_key_version` rotation discipline (90 days).
 */
import { randomBytes, createCipheriv } from 'node:crypto';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export interface DebugCiphertext {
  iv: string;
  tag: string;
  ciphertext: string;
  key_version: number;
}

/**
 * Storage outcome for the encrypted snapshot.
 *
 *   - `s3`     : ciphertext landed in S3 at `s3_uri`. `inline` is null.
 *   - `inline` : ciphertext returned in `inline` for the caller to store
 *                in `runtime_trace_bodies.ciphertext_inline`. `s3_uri` is null.
 */
export interface DebugUploadResult {
  storage: 's3' | 'inline';
  s3_uri: string | null;
  inline: string | null;
  cipher: DebugCiphertext;
}

function getAesKey(): Buffer | null {
  const b64 = config.RUNTIME_TRACE_DEBUG_AES_KEY;
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `RUNTIME_TRACE_DEBUG_AES_KEY must decode to 32 bytes (got ${buf.length}); reconfigure KMS material`,
    );
  }
  return buf;
}

/**
 * Encrypt a packet for debug-mode storage. Returns ciphertext envelope.
 * If AES key isn't configured, returns null (caller MUST treat as failure).
 */
export function encryptForDebug(packet: unknown): DebugCiphertext | null {
  const key = getAesKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(packet ?? null), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ct.toString('base64'),
    key_version: 1,
  };
}

/**
 * Lazy import of the S3 client so test environments that mock `@/db/client`
 * don't need to mock the SDK too. Returns null when import fails (rare —
 * the package is in deps; the lazy hop is for cold-start latency only).
 */
async function loadS3Client(): Promise<{
  S3Client: new (opts: Record<string, unknown>) => unknown;
  PutObjectCommand: new (opts: Record<string, unknown>) => unknown;
} | null> {
  try {
    const mod = (await import('@aws-sdk/client-s3')) as unknown as {
      S3Client: new (opts: Record<string, unknown>) => unknown;
      PutObjectCommand: new (opts: Record<string, unknown>) => unknown;
    };
    return { S3Client: mod.S3Client, PutObjectCommand: mod.PutObjectCommand };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'runtime_trace.debug_s3_client_load_failed',
    );
    return null;
  }
}

/**
 * Persist the ciphertext durably. Two paths:
 *
 *   - Bucket configured → real S3 PutObject. Throws on upload failure
 *     (caller must abort the body write; debug body must never be silently
 *     dropped). Returns `{ storage: 's3', s3_uri, inline: null }`.
 *   - No bucket          → returns `{ storage: 'inline', inline, s3_uri: null }`
 *     and the caller stores the bytes in `runtime_trace_bodies.ciphertext_inline`.
 *     Body remains recoverable via DB; no silent data loss (Codex #102 issue 3).
 */
export async function uploadDebugSnapshot(
  trace_id: string,
  cipher: DebugCiphertext,
): Promise<DebugUploadResult> {
  const bucket = config.RUNTIME_TRACE_DEBUG_S3_BUCKET;
  if (!bucket) {
    // Inline path: return the ciphertext for DB storage. The body row's
    // CHECK constraint requires either s3_uri or ciphertext_inline to be
    // present when encrypted=true, so the contract is enforced at the DB.
    return {
      storage: 'inline',
      s3_uri: null,
      inline: cipher.ciphertext,
      cipher,
    };
  }

  // S3 path: real PutObject. We assemble the encrypted envelope as JSON
  // for grep-ability in S3 ops tooling. ServerSideEncryption defaults to
  // S3-managed AES-256 (additional defense-in-depth over our own AES-GCM).
  const s3Client = await loadS3Client();
  if (!s3Client) {
    throw new Error(
      'p10b: @aws-sdk/client-s3 unavailable but RUNTIME_TRACE_DEBUG_S3_BUCKET is set — cannot upload debug snapshot',
    );
  }
  const { S3Client, PutObjectCommand } = s3Client;
  const region = config.BACKUP_S3_REGION;
  const endpoint = config.BACKUP_S3_ENDPOINT;
  const accessKey = config.BACKUP_S3_ACCESS_KEY;
  const secretKey = config.BACKUP_S3_SECRET_KEY;
  const clientOpts: Record<string, unknown> = { region };
  if (endpoint) clientOpts.endpoint = endpoint;
  if (accessKey && secretKey) {
    clientOpts.credentials = { accessKeyId: accessKey, secretAccessKey: secretKey };
  }
  const client = new S3Client(clientOpts) as {
    send: (cmd: unknown) => Promise<unknown>;
    destroy?: () => void;
  };
  const key = `runtime-trace/debug/${trace_id}.json.enc`;
  const body = JSON.stringify({
    iv: cipher.iv,
    tag: cipher.tag,
    ciphertext: cipher.ciphertext,
    key_version: cipher.key_version,
  });
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
  });
  try {
    await client.send(cmd);
  } finally {
    client.destroy?.();
  }
  const s3_uri = `s3://${bucket}/${key}`;
  return { storage: 's3', s3_uri, inline: null, cipher };
}
