/**
 * Issue #520 §3 — the verifiable backup manifest.
 *
 * A manifest answers, for one artifact, the twelve questions the issue's
 * "Objetivo" section poses: what commit/schema does it represent, what is its
 * checksum, was that checksum verified at the destination, under which key
 * policy is it encrypted, which data classes it covers, which tombstone
 * watermark it carries, and when it was last successfully restored.
 *
 * Design rules:
 *  - The manifest is DATA, produced only from evidence. Nothing here is
 *    "expected"; each field is written after the corresponding stage proved it.
 *  - It is SIGNED (HMAC-SHA256 over a canonical serialisation) so a tampered
 *    manifest cannot pass verification — the issue's "manifesto adulterado"
 *    risk. The signing key is the existing runtime-trace HMAC material, which
 *    already lives OUTSIDE the artifact (issue §5: "não armazenar chaves de
 *    criptografia no mesmo artefato").
 *  - It carries NO secret and NO PII. `assertNoSecrets` is applied before any
 *    signature is produced, so an accidental leak fails the run instead of
 *    being published.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { TypedError } from '@/lib/utils.js';
import { assertNoSecrets } from './redaction.js';
import { digestsMatch } from './checksum.js';

/**
 * Bump when a field's MEANING changes (not when an optional field is added).
 * A restore drill refuses a manifest whose version it does not understand.
 */
export const MANIFEST_VERSION = 1;

export const SIGNATURE_ALG = 'HMAC-SHA256' as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex SHA-256');
const isoDate = z.string().datetime({ offset: true });

export const encryptionMetaSchema = z.object({
  /** `none` is only legal for profiles that do not require encryption. */
  mode: z.enum(['none', 'envelope_aes256_gcm']),
  /** Key IDENTIFIER only — never key material. */
  key_id: z.string().min(1).nullable(),
  key_version: z.number().int().nonnegative().nullable(),
  /** SHA-256 of the CIPHERTEXT as stored. Null when mode is `none`. */
  ciphertext_sha256: hex64.nullable(),
});

export const verificationMetaSchema = z.object({
  /** `pg_restore --list` read the catalog successfully. */
  catalog_readable: z.boolean(),
  /** Local streaming checksum matched the recorded digest. */
  local_checksum_verified: z.boolean(),
  /** Destination HEAD/metadata check matched size + checksum. */
  remote_checksum_verified: z.boolean(),
  remote_verified_at: isoDate.nullable(),
});

export const destinationMetaSchema = z.object({
  kind: z.enum(['local', 's3']),
  /** Opaque, non-disclosing locator (see redaction.opaqueLocator). */
  locator: z.string().min(1).nullable(),
  /** Basename only — never an absolute path or a URL. */
  artifact_ref: z.string().min(1),
});

export const backupManifestSchema = z.object({
  manifest_version: z.literal(MANIFEST_VERSION),
  backup_id: z.string().uuid(),
  correlation_id: z.string().min(1),
  started_at: isoDate,
  finished_at: isoDate,

  // Provenance — issue §3 "commit/build version", "PostgreSQL client/server
  // version", "migration head/schema fingerprint", "configuration fingerprint".
  environment: z.enum(['development', 'test', 'production']),
  profile: z.enum(['development', 'staging', 'production']),
  /** Non-sensitive origin id (e.g. a hashed hostname) — never the raw host. */
  source_id: z.string().min(1),
  app_version: z.string().min(1),
  commit: z.string().nullable(),
  pg_client_version: z.string().nullable(),
  pg_server_version: z.string().nullable(),
  dump_format: z.enum(['custom']),
  migration_head: z.string().nullable(),
  schema_fingerprint: hex64.nullable(),
  config_fingerprint: hex64.nullable(),

  // Artifact.
  size_bytes: z.number().int().nonnegative(),
  sha256: hex64,
  encryption: encryptionMetaSchema,
  destination: destinationMetaSchema,
  verification: verificationMetaSchema,

  // Coverage + lifecycle — issue §3 "classes de dados incluídas/excluídas",
  // "watermark de tombstones", "retention class e delete_after",
  // "legal-hold state", "último restore drill e resultado".
  data_classes_included: z.array(z.string().min(1)),
  data_classes_excluded: z.array(z.string().min(1)),
  tombstone_watermark: isoDate.nullable(),
  retention_class: z.string().min(1),
  delete_after: isoDate.nullable(),
  legal_hold: z.enum(['none', 'held']),
  last_restore_drill_at: isoDate.nullable(),
  last_restore_drill_result: z.enum(['passed', 'failed']).nullable(),

  outcome: z.enum(['completed', 'completed_degraded', 'failed']),
  outcome_reason: z.string().min(1),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export interface SignedManifest {
  manifest: BackupManifest;
  signature: string;
  signature_alg: typeof SIGNATURE_ALG;
  signature_key_version: number;
}

/**
 * Deterministic serialisation: keys sorted at every depth, no whitespace.
 * Two processes must produce byte-identical output for the same manifest or
 * the signature is not verifiable across a restart/redeploy.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return value;
}

/**
 * Validate + sign. Runs the secret guard FIRST: a manifest that somehow picked
 * up a connection string or a phone number must never be persisted, signed or
 * not.
 */
export function signManifest(
  manifest: BackupManifest,
  secret: string,
  keyVersion: number,
): SignedManifest {
  const parsed = backupManifestSchema.parse(manifest);
  assertNoSecrets(parsed, 'backup manifest');
  if (!secret || secret.length === 0) {
    throw new TypedError(
      'backup_manifest_unsignable',
      'manifest signing secret is not configured — an unsigned manifest is not verifiable evidence',
      {},
    );
  }
  const signature = createHmac('sha256', secret).update(canonicalize(parsed), 'utf8').digest('hex');
  return {
    manifest: parsed,
    signature,
    signature_alg: SIGNATURE_ALG,
    signature_key_version: keyVersion,
  };
}

/**
 * Verify a manifest read back from disk / the DB / the destination.
 *
 * Returns a verdict instead of throwing so a restore drill can record WHY a
 * candidate artifact was rejected. A malformed manifest and a forged one are
 * both `false` with a stable reason code — no oracle for an attacker.
 */
export function verifyManifest(
  signed: unknown,
  secret: string,
): { ok: true; manifest: BackupManifest } | { ok: false; reason: string } {
  if (signed === null || typeof signed !== 'object') {
    return { ok: false, reason: 'not_an_object' };
  }
  const envelope = signed as Partial<SignedManifest>;
  if (envelope.signature_alg !== SIGNATURE_ALG) {
    return { ok: false, reason: 'unsupported_signature_alg' };
  }
  if (typeof envelope.signature !== 'string') {
    return { ok: false, reason: 'missing_signature' };
  }
  const parsed = backupManifestSchema.safeParse(envelope.manifest);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid' };
  }
  if (!secret) {
    return { ok: false, reason: 'no_verification_secret' };
  }
  const expected = createHmac('sha256', secret)
    .update(canonicalize(parsed.data), 'utf8')
    .digest('hex');
  if (!digestsMatch(expected, envelope.signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Fail-closed artifact↔manifest binding (issue §4: "artifact/manifest mismatch
 * é falha bloqueante"). Compares the digest just computed over the bytes on
 * disk against what the (already signature-verified) manifest claims.
 */
export function assertArtifactMatchesManifest(
  manifest: BackupManifest,
  observed: { sha256: string; bytes: number },
): void {
  const expectedDigest =
    manifest.encryption.mode === 'none' ? manifest.sha256 : manifest.encryption.ciphertext_sha256;
  if (expectedDigest === null) {
    throw new TypedError(
      'backup_manifest_missing_digest',
      'manifest declares encryption but carries no ciphertext digest',
      { backup_id: manifest.backup_id },
    );
  }
  if (!digestsMatch(expectedDigest, observed.sha256)) {
    throw new TypedError(
      'backup_checksum_mismatch',
      'artifact checksum does not match the signed manifest',
      { backup_id: manifest.backup_id, stage: 'artifact_binding' },
    );
  }
  if (manifest.encryption.mode === 'none' && manifest.size_bytes !== observed.bytes) {
    throw new TypedError(
      'backup_size_mismatch',
      'artifact size does not match the signed manifest',
      { backup_id: manifest.backup_id },
    );
  }
}
