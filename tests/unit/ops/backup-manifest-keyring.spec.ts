import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

/**
 * Issue #536 §1, round-2 review of PR #541, finding #2 — the WIRING between a
 * backup manifest and the versioned HMAC keyring that already existed for
 * audit rows.
 *
 * `tests/unit/ops/backup-manifest.spec.ts` proves `verifyManifest` resolves by
 * version against an arbitrary keyring. What only this file can prove is that
 * the keyring the drill actually uses is THE SAME ONE the runtime-trace
 * consumer uses — one parser for
 * `RUNTIME_TRACE_HMAC_PREV_MASTER_SECRETS`, not two that can drift. A drifted
 * keyring is an unrestorable backup.
 *
 * The mocked config puts the deployment AFTER a rotation: current version 2,
 * with version 1 retained through the audit-retention window.
 */
vi.mock('../../../src/config/env.js', () => ({
  config: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 2,
    RUNTIME_TRACE_HMAC_MASTER_SECRET: undefined,
  },
}));
vi.mock('../../../src/config/contract-env.js', () => ({
  contractEnv: {
    NODE_ENV: 'test',
    RUNTIME_TRACE_HMAC_KEY_VERSION: 2,
    RUNTIME_TRACE_HMAC_MASTER_SECRET: undefined,
  },
}));

import {
  deriveTenantKey,
  hmacMasterSecretForVersion,
  _resetHmacCacheForTests,
  _setTestMasterSecretForTests,
  _setTestKeyringEntryForTests,
  _clearTestMasterSecretForTests,
} from '../../../src/control-plane/runtime-trace/lib/hmac.js';
import { backupManifestKeyring } from '../../../src/ops/backup/manifest-keyring.js';
import {
  MANIFEST_VERSION,
  signManifest,
  verifyManifest,
  type BackupManifest,
} from '../../../src/ops/backup/manifest.js';
import { randomUUID } from 'node:crypto';

const CURRENT_MASTER = 'post-rotation-current-master';
const PREVIOUS_MASTER = 'pre-rotation-previous-master';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function manifest(): BackupManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    backup_id: randomUUID(),
    correlation_id: 'corr-rotation',
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
    destination: {
      kind: 'local',
      locator: null,
      artifact_ref: 'maia-2026-07-28.dump',
    },
    verification: {
      catalog_readable: true,
      local_checksum_verified: true,
      remote_checksum_verified: false,
      remote_verification_method: 'none',
      remote_verification_reason: 'not_attempted',
      remote_verified_at: null,
    },
    data_classes_included: ['postgres.core'],
    data_classes_excluded: ['media.blobs'],
    tombstone_watermark: '2026-07-28T03:00:00.000Z',
    retention_class: 'backup_artifact',
    delete_after: '2026-08-27T03:00:00.000Z',
    legal_hold: 'none',
    last_restore_drill_at: null,
    last_restore_drill_result: null,
    outcome: 'completed',
    outcome_reason: 'verified',
  };
}

beforeEach(() => {
  _resetHmacCacheForTests();
  // Current version (2) → the new master.
  _setTestMasterSecretForTests(CURRENT_MASTER);
  // Retained previous version.
  _setTestKeyringEntryForTests(1, PREVIOUS_MASTER);
});

afterAll(() => {
  _clearTestMasterSecretForTests();
});

describe('backupManifestKeyring', () => {
  it('resolves the CURRENT master for the current version', () => {
    expect(backupManifestKeyring().secretForVersion(2)).toBe(CURRENT_MASTER);
  });

  it('resolves the RETAINED master for a previous version', () => {
    expect(backupManifestKeyring().secretForVersion(1)).toBe(PREVIOUS_MASTER);
  });

  it('FAILS CLOSED for a version this deployment does not hold', () => {
    // The resolver throws; the adapter turns that into a verdict rather than
    // letting it escape as a crash — but it never becomes "try the current key".
    expect(backupManifestKeyring().secretForVersion(9)).toBeNull();
    expect(backupManifestKeyring().secretForVersion(-1)).toBeNull();
  });

  it('is THE keyring the runtime-trace consumer uses, not a second copy', () => {
    // If these ever diverge, backups and audit rows disagree about which key
    // signed what, and one of the two silently stops verifying.
    expect(hmacMasterSecretForVersion(1).toString('utf8')).toBe(
      backupManifestKeyring().secretForVersion(1),
    );
    expect(hmacMasterSecretForVersion(2).toString('utf8')).toBe(
      backupManifestKeyring().secretForVersion(2),
    );
  });
});

describe('runtime-trace consumer is unchanged by the extraction', () => {
  it('still derives a tenant key per version and still fails closed on an unknown one', () => {
    // The exported resolver is additive: `deriveTenantKey` calls the same
    // private function it always did, so both versions still derive and an
    // unheld version still throws with the operator guidance.
    expect(deriveTenantKey('tenant-a', 1)).toHaveLength(32);
    expect(deriveTenantKey('tenant-a', 2)).toHaveLength(32);
    expect(deriveTenantKey('tenant-a', 1).equals(deriveTenantKey('tenant-a', 2))).toBe(false);
    expect(() => deriveTenantKey('tenant-a', 9)).toThrow(/not found in keyring/);
  });
});

describe('a rotation does not strand a recovery point (end to end)', () => {
  it('verifies a manifest signed BEFORE the rotation, with real config resolution', () => {
    // Signed by the pre-rotation process: version 1, previous master.
    const signed = signManifest(manifest(), PREVIOUS_MASTER, 1);
    // Verified by the post-rotation process, which holds version 2 as current.
    expect(verifyManifest(signed, backupManifestKeyring())).toMatchObject({
      ok: true,
      key_version: 1,
    });
  });

  it('verifies a manifest signed AFTER the rotation', () => {
    const signed = signManifest(manifest(), CURRENT_MASTER, 2);
    expect(verifyManifest(signed, backupManifestKeyring())).toMatchObject({
      ok: true,
      key_version: 2,
    });
  });

  it('refuses a manifest whose key was dropped from the keyring entirely', () => {
    const signed = signManifest(manifest(), 'a-master-nobody-retained', 7);
    expect(verifyManifest(signed, backupManifestKeyring())).toEqual({
      ok: false,
      reason: 'key_version_unknown',
    });
  });
});
