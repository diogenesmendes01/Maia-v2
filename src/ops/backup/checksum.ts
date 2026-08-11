/**
 * Issue #520 — streaming integrity primitives.
 *
 * The baseline used `statSync(file).size` as the only "materialised" signal
 * (`src/workers/backup.ts:74-80`). A truncated or silently-corrupted dump has
 * a size too. Every integrity claim in this system is a SHA-256 computed by
 * streaming the artifact — never an ETag (multipart ETags are not a content
 * hash) and never a file size.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export interface ArtifactDigest {
  sha256: string;
  bytes: number;
}

/**
 * Stream a file through SHA-256. Streaming (not `readFile`) is mandatory: a
 * production dump is gigabytes and must never be buffered into the heap of a
 * worker that also serves traffic.
 */
export async function sha256File(path: string): Promise<ArtifactDigest> {
  const hash = createHash('sha256');
  let bytes = 0;
  const source = createReadStream(path);
  source.on('data', (chunk: string | Buffer) => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  await pipeline(source, hash);
  return { sha256: hash.digest('hex'), bytes };
}

export function sha256Buffer(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Constant-time hex-digest comparison.
 *
 * Checksum verification is not a secret-dependent operation in the classical
 * sense, but the manifest is HMAC-signed and the same helper is used to
 * compare signatures — where a timing side channel WOULD matter. One helper,
 * one behaviour, no chance of the signature path accidentally using `===`.
 *
 * Returns false (never throws) on length mismatch or non-hex input so callers
 * can treat "malformed" and "wrong" identically — a malicious manifest must
 * not be able to trigger a different code path than a merely-stale one.
 */
export function digestsMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}
