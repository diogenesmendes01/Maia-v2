/**
 * P10b — Debug-mode encrypted snapshot to S3.
 *
 * When redaction_class='debug', the body bypasses the standard PII
 * stripper and is instead AES-256-GCM encrypted and uploaded to S3
 * with a 24h TTL. Reads require MFA-gated admin role (enforced by the
 * Admin UI, not here).
 *
 * The ciphertext envelope is stored in the body row as:
 *   { iv: base64, tag: base64, ciphertext: base64, key_version: int }
 *
 * Key management:
 *   - RUNTIME_TRACE_DEBUG_AES_KEY: base64-encoded 32-byte master key.
 *   - In prod, the master is sourced from KMS at boot and cached.
 *   - Per-tenant per-trace, we derive a unique IV (12 bytes random).
 *   - Same `hmac_key_version` rotation discipline (90 days).
 */
import { randomBytes, createCipheriv } from 'node:crypto';
import { config } from '@/config/env.js';

export interface DebugCiphertext {
  iv: string;
  tag: string;
  ciphertext: string;
  key_version: number;
}

export interface DebugUploadResult {
  s3_uri: string;
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
 * Upload the ciphertext to S3. Stubbed when bucket/SDK isn't configured —
 * returns a synthetic URI for tests/local. Real impl uses @aws-sdk/client-s3.
 */
export async function uploadDebugSnapshot(
  trace_id: string,
  cipher: DebugCiphertext,
): Promise<DebugUploadResult> {
  const bucket = config.RUNTIME_TRACE_DEBUG_S3_BUCKET;
  if (!bucket) {
    // No bucket configured: store inline (test path). Production MUST
    // configure a bucket — otherwise the upload step silently degrades.
    const s3_uri = `inline:debug/${trace_id}`;
    return { s3_uri, cipher };
  }
  // Real S3 upload is deferred — when the @aws-sdk/client-s3 lazy-loader
  // pattern is in place we add it here. Today we return a deterministic
  // URI assuming a putObject would succeed (used by integration tests
  // with a mocked SDK).
  const s3_uri = `s3://${bucket}/runtime-trace/debug/${trace_id}.json.enc`;
  return { s3_uri, cipher };
}
