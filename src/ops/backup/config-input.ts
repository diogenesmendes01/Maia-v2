/**
 * The one projection of the loaded configuration onto the slice
 * `resolveBackupProfile` reads.
 *
 * It lived inside `src/workers/backup.ts` while the worker was the only caller.
 * Issue #536 added a second one — the readiness collector
 * (`src/observability/backup-readiness-collector.ts`) grades the same profile
 * at scrape time — and two copies of this list would be two ways to answer
 * "does this profile require an off-site copy?". It is extracted verbatim, not
 * rewritten.
 *
 * Explicit field-by-field rather than passing `config` wholesale: the list is
 * the compile-time contract between the runtime and `src/ops/backup/profile.ts`,
 * so renaming a variable in `src/config/contract.ts` breaks the build here
 * instead of silently resolving to `undefined`.
 *
 * The Maia PROFILE comes from `resolveProfile` (issue #515), not from a
 * backup-specific selector — `MAIA_ENV` is the single source of truth, and
 * `resolveProfile` is pure (it reads the snapshot it is handed, not
 * `process.env`).
 */
import { config } from '@/config/env.js';
import { resolveProfile } from '@/config/profiles.js';
import {
  resolveBackupProfile,
  type BackupConfigInput,
  type ResolvedBackupProfile,
} from './profile.js';

export function backupConfigInput(): BackupConfigInput {
  const { profile } = resolveProfile({
    MAIA_ENV: config.MAIA_ENV,
    NODE_ENV: config.NODE_ENV,
  });
  return {
    profile,
    BACKUP_ENABLED: config.BACKUP_ENABLED,
    BACKUP_DIR: config.BACKUP_DIR,
    BACKUP_RETENTION_LOCAL_DAYS: config.BACKUP_RETENTION_LOCAL_DAYS,
    BACKUP_RETENTION_CLOUD_DAYS: config.BACKUP_RETENTION_CLOUD_DAYS,
    BACKUP_S3_BUCKET: config.BACKUP_S3_BUCKET,
    BACKUP_S3_ACCESS_KEY: config.BACKUP_S3_ACCESS_KEY,
    BACKUP_S3_SECRET_KEY: config.BACKUP_S3_SECRET_KEY,
    BACKUP_S3_ENDPOINT: config.BACKUP_S3_ENDPOINT,
    BACKUP_OFFSITE_REQUIRED: config.BACKUP_OFFSITE_REQUIRED,
    BACKUP_ENCRYPTION_MODE: config.BACKUP_ENCRYPTION_MODE,
    BACKUP_ENCRYPTION_KEYRING: config.BACKUP_ENCRYPTION_KEYRING,
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: config.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
    BACKUP_DUMP_TIMEOUT_MS: config.BACKUP_DUMP_TIMEOUT_MS,
    BACKUP_UPLOAD_TIMEOUT_MS: config.BACKUP_UPLOAD_TIMEOUT_MS,
    BACKUP_RESTORE_TIMEOUT_MS: config.BACKUP_RESTORE_TIMEOUT_MS,
    BACKUP_MIN_ARTIFACT_BYTES: config.BACKUP_MIN_ARTIFACT_BYTES,
    BACKUP_RPO_TARGET_HOURS: config.BACKUP_RPO_TARGET_HOURS,
    BACKUP_RTO_TARGET_MINUTES: config.BACKUP_RTO_TARGET_MINUTES,
    BACKUP_RESTORE_DRILL_INTERVAL_HOURS: config.BACKUP_RESTORE_DRILL_INTERVAL_HOURS,
    RETENTION_DRY_RUN: config.RETENTION_DRY_RUN,
  };
}

/** The resolved profile for the current process. */
export function backupProfile(): ResolvedBackupProfile {
  return resolveBackupProfile(backupConfigInput());
}
