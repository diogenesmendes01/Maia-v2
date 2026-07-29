/**
 * Issue #520 §4 — proving the OFF-SITE copy is the artifact we produced.
 *
 * ROUND-1 REVIEW FINDING (P1). The first implementation stamped the SHA-256
 * into S3 user metadata on upload and then read THAT SAME STAMP back with
 * `HEAD`, comparing it to the local digest. That verifies nothing: user
 * metadata is client-asserted and is stored alongside the object, not derived
 * from it. If the stored bytes rot, the metadata still matches and the run is
 * marked `remote_verified` / `completed`. The check could not fail for the one
 * reason it existed to catch.
 *
 * Two things count as evidence here, and nothing else does:
 *
 *   provider_checksum — the provider COMPUTED the digest over the bytes it
 *                       stored (`ChecksumSHA256`, returned by HEAD with
 *                       `ChecksumMode: ENABLED`). S3 validates it on receipt
 *                       and recomputes it from storage.
 *   full_download     — we streamed the object back and recomputed the digest
 *                       ourselves. Slower, but works against any provider.
 *
 * User metadata survives in `RemoteHead` purely as a diagnostic label, and this
 * module NEVER reads it when deciding. That is enforced by
 * `tests/unit/ops/remote-verify.spec.ts`, whose fake returns matching metadata
 * over corrupted bytes and expects a FAILED verification.
 *
 * PURE decision logic with injected IO, so the adversarial cases can be
 * exercised without a bucket.
 */
import { digestsMatch } from './checksum.js';

export type RemoteVerificationMethod = 'provider_checksum' | 'full_download' | 'none';

export type RemoteVerificationReason =
  | 'ok'
  | 'object_missing'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'no_provider_checksum'
  | 'download_failed';

export interface RemoteHead {
  /** Size the provider reports for the stored object. */
  bytes: number | null;
  /**
   * Digest the PROVIDER computed over the stored bytes, base64 (the S3
   * `ChecksumSHA256` shape). `null` when the provider does not support it.
   */
  providerSha256Base64: string | null;
  /**
   * Digest the UPLOADER wrote into user metadata. DIAGNOSTIC ONLY — never an
   * input to the verdict. Kept so an operator can tell "the provider does not
   * support checksums" apart from "nobody ever stamped one".
   */
  metadataSha256Hex: string | null;
}

export interface RemoteVerifyDeps {
  head(key: string): Promise<RemoteHead | null>;
  /** Stream the stored object back and recompute its digest. */
  downloadAndDigest(key: string): Promise<{ sha256: string; bytes: number } | null>;
  /**
   * Whether this run may spend the egress on a full re-download when the
   * provider offers no checksum. False turns "unverifiable" into an explicit
   * failure instead of a silent pass.
   */
  allowFullDownload: boolean;
}

export interface RemoteVerification {
  verified: boolean;
  method: RemoteVerificationMethod;
  reason: RemoteVerificationReason;
}

/** base64 (S3 `ChecksumSHA256`) → lowercase hex, or `null` when malformed. */
export function base64ToHex(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  // A SHA-256 is exactly 32 bytes. Anything else is not the digest we asked
  // for, and guessing would be how a truncated value passes.
  if (buf.length !== 32) return null;
  return buf.toString('hex');
}

/** lowercase hex → base64, for the `ChecksumSHA256` header on upload. */
export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/**
 * Decide whether the object at `key` is byte-identical to what we produced.
 *
 * Order: cheap structural checks first (existence, size), then the provider's
 * own digest, then — only if the provider has none and policy allows it — a
 * full re-download. Any doubt is `verified: false`; the caller turns that into
 * `completed_degraded` or `failed` per profile.
 */
export async function verifyRemoteArtifact(
  deps: RemoteVerifyDeps,
  key: string,
  expected: { sha256: string; bytes: number },
): Promise<RemoteVerification> {
  let head: RemoteHead | null;
  try {
    head = await deps.head(key);
  } catch {
    head = null;
  }
  if (head === null) {
    return { verified: false, method: 'none', reason: 'object_missing' };
  }

  // Size disagreement is conclusive on its own and costs nothing.
  if (head.bytes !== null && head.bytes !== expected.bytes) {
    return { verified: false, method: 'none', reason: 'size_mismatch' };
  }

  if (head.providerSha256Base64 !== null) {
    const providerHex = base64ToHex(head.providerSha256Base64);
    if (providerHex === null || !digestsMatch(providerHex, expected.sha256)) {
      return { verified: false, method: 'provider_checksum', reason: 'checksum_mismatch' };
    }
    return { verified: true, method: 'provider_checksum', reason: 'ok' };
  }

  // No provider-computed digest. User metadata is NOT a substitute — read the
  // bytes back or report the copy as unverified.
  if (!deps.allowFullDownload) {
    return { verified: false, method: 'none', reason: 'no_provider_checksum' };
  }

  let recomputed: { sha256: string; bytes: number } | null;
  try {
    recomputed = await deps.downloadAndDigest(key);
  } catch {
    recomputed = null;
  }
  if (recomputed === null) {
    return { verified: false, method: 'full_download', reason: 'download_failed' };
  }
  if (recomputed.bytes !== expected.bytes) {
    return { verified: false, method: 'full_download', reason: 'size_mismatch' };
  }
  if (!digestsMatch(recomputed.sha256, expected.sha256)) {
    return { verified: false, method: 'full_download', reason: 'checksum_mismatch' };
  }
  return { verified: true, method: 'full_download', reason: 'ok' };
}
