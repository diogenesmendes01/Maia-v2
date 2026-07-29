import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MANIFEST_VERSION,
  canonicalize,
  signManifest,
  verifyManifest,
  assertArtifactMatchesManifest,
  type BackupManifest,
} from '../../../src/ops/backup/manifest.js';

const SECRET = 'unit-test-manifest-secret';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    backup_id: randomUUID(),
    correlation_id: 'corr-1',
    started_at: '2026-07-28T03:00:00.000Z',
    finished_at: '2026-07-28T03:04:00.000Z',
    environment: 'production',
    profile: 'production',
    source_id: 'host-9f2c',
    app_version: '3.1.0',
    commit: 'd93624b',
    pg_client_version: '16.4',
    pg_server_version: '16.4',
    dump_format: 'custom',
    migration_head: '095_approval_requests.sql',
    schema_fingerprint: DIGEST_B,
    config_fingerprint: DIGEST_B,
    size_bytes: 1024,
    sha256: DIGEST_A,
    encryption: {
      mode: 'none',
      key_id: null,
      key_version: null,
      ciphertext_sha256: null,
    },
    destination: { kind: 'local', locator: null, artifact_ref: 'maia-2026-07-28.dump' },
    verification: {
      catalog_readable: true,
      local_checksum_verified: true,
      remote_checksum_verified: false,
      // Manifest v2: nothing attested the stored bytes for a local-only run.
      remote_verification_method: 'none',
      remote_verification_reason: 'not_attempted',
      remote_verified_at: null,
    },
    data_classes_included: ['postgres.core'],
    data_classes_excluded: ['media.blobs', 'gateway.baileys_session', 'queue.redis'],
    tombstone_watermark: '2026-07-28T03:00:00.000Z',
    retention_class: 'backup_artifact',
    delete_after: '2026-08-27T03:00:00.000Z',
    legal_hold: 'none',
    last_restore_drill_at: null,
    last_restore_drill_result: null,
    outcome: 'completed_degraded',
    outcome_reason: 'offsite_not_configured',
    ...over,
  };
}

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('preserves array order (arrays are data, not sets)', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe('signManifest / verifyManifest', () => {
  it('round-trips a valid manifest', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    const verdict = verifyManifest(signed, SECRET);
    expect(verdict.ok).toBe(true);
  });

  it('detects a tampered field (the "manifesto adulterado" risk)', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, sha256: DIGEST_B },
    };
    expect(verifyManifest(tampered, SECRET)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a manifest signed with a different key', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    expect(verifyManifest(signed, 'other-secret')).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a schema-invalid manifest without throwing (no oracle)', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    const broken = { ...signed, manifest: { ...signed.manifest, sha256: 'not-a-digest' } };
    expect(verifyManifest(broken, SECRET)).toEqual({ ok: false, reason: 'schema_invalid' });
  });

  it('rejects a downgraded signature algorithm', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    expect(verifyManifest({ ...signed, signature_alg: 'none' }, SECRET)).toEqual({
      ok: false,
      reason: 'unsupported_signature_alg',
    });
  });

  it('refuses to sign without a secret (unsigned evidence is not evidence)', () => {
    expect(() => signManifest(manifest(), '', 1)).toThrowError(/not verifiable evidence/);
  });

  it('refuses to sign a manifest carrying a secret or PII', () => {
    expect(() =>
      signManifest(manifest({ source_id: 'postgres://u:p@host/maia' }), SECRET, 1),
    ).toThrowError(/must never be persisted/);
  });

  it('never stores key material — only a key identifier', () => {
    const signed = signManifest(
      manifest({
        encryption: {
          mode: 'envelope_aes256_gcm',
          key_id: 'backup-2026-07',
          key_version: 1,
          ciphertext_sha256: DIGEST_B,
        },
      }),
      SECRET,
      1,
    );
    const body = JSON.stringify(signed.manifest);
    expect(body).toContain('backup-2026-07');
    expect(Object.keys(signed.manifest.encryption)).toEqual([
      'mode',
      'key_id',
      'key_version',
      'ciphertext_sha256',
    ]);
  });
});

describe('assertArtifactMatchesManifest', () => {
  it('accepts a matching plaintext artifact', () => {
    expect(() =>
      assertArtifactMatchesManifest(manifest(), { sha256: DIGEST_A, bytes: 1024 }),
    ).not.toThrow();
  });

  it('blocks a checksum mismatch', () => {
    expect(() =>
      assertArtifactMatchesManifest(manifest(), { sha256: DIGEST_B, bytes: 1024 }),
    ).toThrowError(/does not match the signed manifest/);
  });

  it('blocks a size mismatch even when the digest was faked to match', () => {
    expect(() =>
      assertArtifactMatchesManifest(manifest(), { sha256: DIGEST_A, bytes: 9 }),
    ).toThrowError(/size does not match/);
  });

  it('compares the CIPHERTEXT digest when the artifact is encrypted', () => {
    const m = manifest({
      encryption: {
        mode: 'envelope_aes256_gcm',
        key_id: 'k1',
        key_version: 1,
        ciphertext_sha256: DIGEST_B,
      },
    });
    expect(() => assertArtifactMatchesManifest(m, { sha256: DIGEST_B, bytes: 2048 })).not.toThrow();
    expect(() => assertArtifactMatchesManifest(m, { sha256: DIGEST_A, bytes: 2048 })).toThrowError(
      /does not match the signed manifest/,
    );
  });

  it('fails closed when an encrypted manifest carries no ciphertext digest', () => {
    const m = manifest({
      encryption: {
        mode: 'envelope_aes256_gcm',
        key_id: 'k1',
        key_version: 1,
        ciphertext_sha256: null,
      },
    });
    expect(() => assertArtifactMatchesManifest(m, { sha256: DIGEST_B, bytes: 1 })).toThrowError(
      /carries no ciphertext digest/,
    );
  });
});
