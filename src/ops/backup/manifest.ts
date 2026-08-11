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
/**
 * v2 (issue #520 round-1 review, P1): `verification.remote_checksum_verified`
 * CHANGED MEANING. In v1 it could be true because the uploader's own user
 * metadata came back from `HEAD` — it did not attest to the stored bytes at
 * all. In v2 it is true only when a provider-computed checksum matched or the
 * object was downloaded and re-hashed, and the new
 * `remote_verification_method` records which. A meaning change, so the version
 * moves and a restore drill refuses a manifest it does not understand.
 */
export const MANIFEST_VERSION = 2;

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
  /**
   * The STORED bytes were proven to be the artifact we produced. True only via
   * `provider_checksum` or `full_download` — never via the uploader's own
   * metadata stamp (see `src/ops/backup/remote-verify.ts`).
   */
  remote_checksum_verified: z.boolean(),
  /** Which mechanism proved it. `none` = nothing did. */
  remote_verification_method: z.enum(['provider_checksum', 'full_download', 'none']),
  /** Stable outcome code from the verifier, for the operator's triage. */
  remote_verification_reason: z.string().min(1),
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
  /**
   * WHICH key signed this envelope. Persisted (`backup_manifests`) since #520
   * and, since the round-2 review of PR #541, actually USED: it is the selector
   * a verifier resolves against its keyring.
   */
  signature_key_version: number;
}

/**
 * How a verifier resolves the secret that a given key VERSION was signed with.
 *
 * Deliberately not a bare secret. A verifier handed one secret ignores
 * `signature_key_version` and therefore only ever verifies manifests signed
 * with the key it happens to hold now — so the first HMAC rotation turns every
 * recovery point still inside its retention window into
 * `manifest_unverifiable`, and the rotation itself becomes the event that
 * destroys the ability to restore valid backups. The envelope names the
 * version; the keyring answers whether this deployment still holds that key.
 *
 * Mirrors the runtime-trace keyring
 * (`src/control-plane/runtime-trace/lib/hmac.ts`), which solved the same
 * problem for audit rows — see `src/ops/backup/manifest-keyring.ts` for the
 * adapter that reuses it.
 */
export interface ManifestKeyring {
  /**
   * The signing secret for `version`, or `null` when this deployment does not
   * hold it. FAIL-CLOSED: returning `null` (or throwing) yields
   * `key_version_unknown` — never a silent fall back to the current key, which
   * would report `signature_mismatch` for a perfectly good manifest and, worse,
   * would accept a forged envelope that renamed its own key version.
   */
  secretForVersion(version: number): string | null;
}

/**
 * Keyring for a deployment that has never rotated — and the shape unit tests
 * want. Version-BOUND on purpose: it answers for exactly one version, so even
 * the trivial case cannot verify a manifest that claims a different key.
 */
export function singleVersionKeyring(secret: string, version: number): ManifestKeyring {
  return { secretForVersion: (v) => (v === version ? secret : null) };
}

/**
 * A key version is a SELECTOR that picks signing material, so it is validated
 * before it is allowed to pick anything. `RUNTIME_TRACE_HMAC_KEY_VERSION` is
 * typed `posInt(1)` in the config contract, so anything that is not a positive
 * safe integer did not come from a signer — `NaN`, `1.5`, `"1"` and
 * `{toString(){…}}` are all adulterated selectors and are refused as such
 * rather than being handed to a keyring to interpret.
 */
function isValidKeyVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
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
  // Symmetry with `verifyManifest`: a version the verifier would refuse as an
  // adulterated selector must never be produced here, or the run would publish
  // an artifact that is unverifiable from the moment it is written.
  if (!isValidKeyVersion(keyVersion)) {
    throw new TypedError(
      'backup_manifest_unsignable',
      'manifest key version is not a positive integer — the envelope would not be verifiable',
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
 *
 * The HMAC is computed with the secret for the version the ENVELOPE names, not
 * with whichever secret the process happens to hold. Before the round-2 review
 * of PR #541 this function took a bare secret and ignored
 * `signature_key_version` entirely, which meant an HMAC rotation silently
 * invalidated every recovery point signed with the previous key — inside its
 * retention window, and with no failure until someone tried to restore.
 */
export function verifyManifest(
  signed: unknown,
  keyring: ManifestKeyring,
): { ok: true; manifest: BackupManifest; key_version: number } | { ok: false; reason: string } {
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
  // The selector is checked BEFORE it is used to pick key material.
  if (!isValidKeyVersion(envelope.signature_key_version)) {
    return { ok: false, reason: 'invalid_key_version' };
  }
  const parsed = backupManifestSchema.safeParse(envelope.manifest);
  if (!parsed.success) {
    return { ok: false, reason: 'schema_invalid' };
  }

  let secret: string | null;
  try {
    secret = keyring.secretForVersion(envelope.signature_key_version);
  } catch {
    // A keyring that cannot answer is not a keyring that said yes. Whatever
    // went wrong (missing config, unparsable material), the outcome is the
    // same: this build cannot verify this envelope.
    secret = null;
  }
  if (secret === null) {
    // Distinct from `signature_mismatch` on purpose: this deployment does not
    // HOLD the key that signed the manifest, which is an operator action
    // (retain the previous master secret), not evidence of tampering.
    return { ok: false, reason: 'key_version_unknown' };
  }
  if (secret.length === 0) {
    return { ok: false, reason: 'no_verification_secret' };
  }

  const expected = createHmac('sha256', secret)
    .update(canonicalize(parsed.data), 'utf8')
    .digest('hex');
  if (!digestsMatch(expected, envelope.signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, manifest: parsed.data, key_version: envelope.signature_key_version };
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
