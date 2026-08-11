import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MANIFEST_VERSION,
  canonicalize,
  signManifest,
  verifyManifest,
  singleVersionKeyring,
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
    const verdict = verifyManifest(signed, singleVersionKeyring(SECRET, 1));
    expect(verdict.ok).toBe(true);
  });

  it('detects a tampered field (the "manifesto adulterado" risk)', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, sha256: DIGEST_B },
    };
    expect(verifyManifest(tampered, singleVersionKeyring(SECRET, 1))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a manifest signed with a different key', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    expect(verifyManifest(signed, singleVersionKeyring('other-secret', 1))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a schema-invalid manifest without throwing (no oracle)', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    const broken = { ...signed, manifest: { ...signed.manifest, sha256: 'not-a-digest' } };
    expect(verifyManifest(broken, singleVersionKeyring(SECRET, 1))).toEqual({
      ok: false,
      reason: 'schema_invalid',
    });
  });

  it('rejects a downgraded signature algorithm', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    expect(
      verifyManifest({ ...signed, signature_alg: 'none' }, singleVersionKeyring(SECRET, 1)),
    ).toEqual({
      ok: false,
      reason: 'unsupported_signature_alg',
    });
  });

  it('refuses to sign without a secret (unsigned evidence is not evidence)', () => {
    expect(() => signManifest(manifest(), '', 1)).toThrowError(/not verifiable evidence/);
  });

  it('refuses to sign under a key version the verifier would refuse', () => {
    // Symmetry: producing an envelope whose selector `verifyManifest` rejects
    // would publish an artifact that is unverifiable from the moment it is
    // written.
    for (const bad of [0, -1, 1.5, NaN, '1' as unknown as number]) {
      expect(() => signManifest(manifest(), SECRET, bad)).toThrowError(
        /key version is not a positive integer/,
      );
    }
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

/**
 * Round-2 review of PR #541, finding #2 — verification resolves the key BY THE
 * VERSION the envelope names.
 *
 * `verifyManifest` used to take a bare secret and ignore
 * `signature_key_version` entirely, so the first HMAC rotation turned every
 * manifest signed with the previous key into `manifest_unverifiable` — inside
 * its retention window, with no failure until someone needed the restore. A
 * keyring, not a secret, is the fix, and it is fail-closed in both directions:
 * an unknown version is refused, and a KNOWN version that did not sign this
 * envelope is refused too.
 */
describe('verifyManifest — the key VERSION selects the key (#541 round 2)', () => {
  /** A deployment that rotated: v2 is current, v1 is retained for the window. */
  const rotated = {
    secretForVersion: (v: number) => (v === 2 ? 'new-master' : v === 1 ? 'old-master' : null),
  };

  it('verifies with the CURRENT key', () => {
    const signed = signManifest(manifest(), 'new-master', 2);
    expect(verifyManifest(signed, rotated)).toMatchObject({
      ok: true,
      key_version: 2,
    });
  });

  it('verifies with the PREVIOUS key — a rotation does not strand a backup', () => {
    const signed = signManifest(manifest(), 'old-master', 1);
    expect(verifyManifest(signed, rotated)).toMatchObject({
      ok: true,
      key_version: 1,
    });
  });

  it('FAILS CLOSED for a version the keyring does not hold', () => {
    const signed = signManifest(manifest(), 'ancient-master', 9);
    expect(verifyManifest(signed, rotated)).toEqual({
      ok: false,
      reason: 'key_version_unknown',
    });
  });

  it('FAILS CLOSED when the keyring itself throws', () => {
    const exploding = {
      secretForVersion: (): string => {
        throw new Error('keyring unreadable');
      },
    };
    const signed = signManifest(manifest(), 'new-master', 2);
    expect(verifyManifest(signed, exploding)).toEqual({
      ok: false,
      reason: 'key_version_unknown',
    });
  });

  it('refuses an envelope that RELABELLED its own key version', () => {
    // Signed with v1/old-master, relabelled to claim v2. The keyring holds v2,
    // so a verifier that trusted the selector would compute with `new-master`
    // and reject; one that ignored the selector entirely would compute with
    // whichever secret it holds. Either way this must not verify.
    const signed = signManifest(manifest(), 'old-master', 1);
    expect(verifyManifest({ ...signed, signature_key_version: 2 }, rotated)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a selector that is not a positive integer before consulting the keyring', () => {
    const signed = signManifest(manifest(), 'new-master', 2);
    const asked: unknown[] = [];
    const spy = {
      secretForVersion: (v: number) => {
        asked.push(v);
        return 'new-master';
      },
    };
    for (const bad of [undefined, null, '2', 2.5, NaN, 0, -1, { valueOf: () => 2 }]) {
      expect(
        verifyManifest({ ...signed, signature_key_version: bad as unknown as number }, spy),
      ).toEqual({ ok: false, reason: 'invalid_key_version' });
    }
    // The adulterated selector never reached the key material.
    expect(asked).toEqual([]);
  });

  it('reports an empty secret as such, not as an unknown version', () => {
    const signed = signManifest(manifest(), SECRET, 1);
    expect(verifyManifest(signed, singleVersionKeyring('', 1))).toEqual({
      ok: false,
      reason: 'no_verification_secret',
    });
  });

  it('singleVersionKeyring answers for exactly one version', () => {
    const ring = singleVersionKeyring(SECRET, 3);
    expect(ring.secretForVersion(3)).toBe(SECRET);
    expect(ring.secretForVersion(2)).toBeNull();
    expect(verifyManifest(signManifest(manifest(), SECRET, 1), ring)).toEqual({
      ok: false,
      reason: 'key_version_unknown',
    });
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
