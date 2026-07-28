import { describe, it, expect } from 'vitest';
import {
  resolveBackupProfile,
  type BackupConfigInput,
} from '../../../src/ops/backup/profile.js';

/**
 * Issue #520 §1 — RESOLUTION only.
 *
 * Since the rebase onto #515 the fail-closed VERDICTS live in
 * `src/config/rules.ts` (rule family `backup/*`) and are covered by
 * `tests/unit/config/backup-rules.spec.ts`. This spec covers what remains
 * here: given the coerced values and the Maia profile, what does the runner
 * consider required and configured?
 *
 * There is no `BACKUP_PROFILE` any more — the profile is `MAIA_ENV`.
 */

function input(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    profile: 'development',
    BACKUP_ENABLED: true,
    BACKUP_DIR: './backups',
    BACKUP_RETENTION_LOCAL_DAYS: 7,
    BACKUP_RETENTION_CLOUD_DAYS: 30,
    BACKUP_ENCRYPTION_MODE: 'none',
    BACKUP_DUMP_TIMEOUT_MS: 3_600_000,
    BACKUP_UPLOAD_TIMEOUT_MS: 1_800_000,
    BACKUP_RESTORE_TIMEOUT_MS: 3_600_000,
    BACKUP_MIN_ARTIFACT_BYTES: 4096,
    BACKUP_RPO_TARGET_HOURS: 24,
    BACKUP_RTO_TARGET_MINUTES: 120,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: 168,
    RETENTION_DRY_RUN: true,
    ...over,
  };
}

function prod(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return input({
    profile: 'production',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_S3_ACCESS_KEY: 'ak',
    BACKUP_S3_SECRET_KEY: 'sk',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"' + 'A'.repeat(43) + '="}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    ...over,
  });
}

describe('resolveBackupProfile — the profile comes from MAIA_ENV', () => {
  it('carries the resolved Maia profile through unchanged', () => {
    expect(resolveBackupProfile(input({ profile: 'staging' })).name).toBe('staging');
    expect(resolveBackupProfile(prod()).name).toBe('production');
  });

  it('requires off-site by default in production only', () => {
    expect(resolveBackupProfile(prod()).offsite.required).toBe(true);
    expect(resolveBackupProfile(input()).offsite.required).toBe(false);
    expect(resolveBackupProfile(input({ profile: 'staging' })).offsite.required).toBe(false);
  });

  it('lets an operator opt IN to off-site outside production', () => {
    expect(
      resolveBackupProfile(input({ BACKUP_OFFSITE_REQUIRED: true })).offsite.required,
    ).toBe(true);
  });

  it('treats an absent BACKUP_OFFSITE_REQUIRED as "the profile decides"', () => {
    // Tri-state: undefined is NOT false.
    expect(
      resolveBackupProfile(prod({ BACKUP_OFFSITE_REQUIRED: undefined })).offsite.required,
    ).toBe(true);
    expect(
      resolveBackupProfile(prod({ BACKUP_OFFSITE_REQUIRED: false })).offsite.required,
    ).toBe(false);
  });

  it('reports a destination as configured only when a bucket is set', () => {
    expect(resolveBackupProfile(prod()).offsite.configured).toBe(true);
    expect(resolveBackupProfile(prod({ BACKUP_S3_BUCKET: undefined })).offsite.configured).toBe(
      false,
    );
    expect(resolveBackupProfile(prod()).offsite.kind).toBe('s3');
    expect(resolveBackupProfile(input()).offsite.kind).toBe('none');
  });

  it('treats any non-none encryption mode as required', () => {
    expect(resolveBackupProfile(prod()).encryption.required).toBe(true);
    expect(resolveBackupProfile(input()).encryption.required).toBe(false);
  });

  it('reports the keyring as configured only with BOTH keyring and active id', () => {
    expect(resolveBackupProfile(prod()).encryption.keyConfigured).toBe(true);
    expect(
      resolveBackupProfile(prod({ BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined })).encryption
        .keyConfigured,
    ).toBe(false);
    expect(
      resolveBackupProfile(prod({ BACKUP_ENCRYPTION_KEYRING: undefined })).encryption
        .keyConfigured,
    ).toBe(false);
  });

  it('flags partial S3 credentials (both or neither)', () => {
    expect(resolveBackupProfile(prod()).offsite.credentialsComplete).toBe(true);
    expect(
      resolveBackupProfile(prod({ BACKUP_S3_SECRET_KEY: undefined })).offsite
        .credentialsComplete,
    ).toBe(false);
    // Neither = an instance role, which is legitimate.
    expect(
      resolveBackupProfile(
        prod({ BACKUP_S3_ACCESS_KEY: undefined, BACKUP_S3_SECRET_KEY: undefined }),
      ).offsite.credentialsComplete,
    ).toBe(true);
  });

  it('never exposes key material — only the active key id', () => {
    const p = resolveBackupProfile(prod());
    expect(p.encryption.activeKeyId).toBe('k1');
    expect(JSON.stringify(p)).not.toContain('AAAA');
  });

  it('carries the objectives and the dry-run posture through', () => {
    const p = resolveBackupProfile(input({ RETENTION_DRY_RUN: true }));
    expect(p.objectives).toEqual({
      rpoHours: 24,
      rtoMinutes: 120,
      restoreDrillIntervalHours: 168,
    });
    expect(p.retention.dryRun).toBe(true);
  });
});
