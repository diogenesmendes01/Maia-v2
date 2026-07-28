/**
 * Issue #520 §1 — the backup/restore configuration contract.
 *
 * Baseline gap (`src/config/env.ts:78-89`): retention + S3 knobs exist, but
 * nothing states what a given ENVIRONMENT *requires*. S3 was optional
 * everywhere, so a production host silently ran local-only forever.
 *
 * This module is PURE — it takes a plain record and returns a resolved profile
 * plus a list of issues. It deliberately does NOT import `@/config/env.js`:
 * `env.ts` calls `validateBackupProfile` from its own `superRefine`, so a
 * config import here would be a cycle. Keeping it pure also means the
 * validation can be exercised in unit tests for every profile without
 * mutating `process.env`.
 */

export type BackupProfileName = 'development' | 'staging' | 'production';
export type EncryptionMode = 'none' | 'envelope_aes256_gcm';
export type OffsiteKind = 'none' | 's3';

/** Raw, already-coerced env slice this module understands. */
export interface BackupConfigInput {
  NODE_ENV: 'development' | 'test' | 'production';
  BACKUP_PROFILE?: BackupProfileName;
  BACKUP_ENABLED: boolean;
  BACKUP_DIR: string;
  BACKUP_RETENTION_LOCAL_DAYS: number;
  BACKUP_RETENTION_CLOUD_DAYS: number;
  BACKUP_S3_BUCKET?: string;
  BACKUP_S3_ACCESS_KEY?: string;
  BACKUP_S3_SECRET_KEY?: string;
  BACKUP_S3_ENDPOINT?: string;
  BACKUP_OFFSITE_REQUIRED?: boolean;
  BACKUP_ENCRYPTION_MODE: EncryptionMode;
  BACKUP_ENCRYPTION_KEYRING?: string;
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID?: string;
  BACKUP_DUMP_TIMEOUT_MS: number;
  BACKUP_UPLOAD_TIMEOUT_MS: number;
  BACKUP_RESTORE_TIMEOUT_MS: number;
  BACKUP_MIN_ARTIFACT_BYTES: number;
  BACKUP_RPO_TARGET_HOURS: number;
  BACKUP_RTO_TARGET_MINUTES: number;
  BACKUP_RESTORE_DRILL_INTERVAL_HOURS: number;
  RETENTION_DRY_RUN: boolean;
}

export interface ResolvedBackupProfile {
  name: BackupProfileName;
  enabled: boolean;
  dir: string;
  offsite: {
    kind: OffsiteKind;
    /** Profile demands a verified remote copy for a run to be `completed`. */
    required: boolean;
    /** A destination is configured at all (bucket present). */
    configured: boolean;
    /** Both access key and secret present (or neither — instance role). */
    credentialsComplete: boolean;
  };
  encryption: {
    mode: EncryptionMode;
    required: boolean;
    keyConfigured: boolean;
    activeKeyId: string | null;
  };
  timeouts: { dumpMs: number; uploadMs: number; restoreMs: number };
  objectives: {
    rpoHours: number;
    rtoMinutes: number;
    restoreDrillIntervalHours: number;
  };
  artifact: { minBytes: number };
  retention: { localDays: number; cloudDays: number; dryRun: boolean };
}

export interface ProfileIssue {
  /** Env var (or pseudo-path) the operator must fix. */
  path: string;
  /** Operator-facing remediation. MUST NOT quote any secret value. */
  message: string;
}

/**
 * Default profile inference: `NODE_ENV=production` ⇒ the `production` profile
 * unless the operator pinned one explicitly. `test` maps to `development` so
 * the suite never demands an S3 bucket.
 */
export function inferProfileName(input: BackupConfigInput): BackupProfileName {
  if (input.BACKUP_PROFILE) return input.BACKUP_PROFILE;
  return input.NODE_ENV === 'production' ? 'production' : 'development';
}

export function resolveBackupProfile(input: BackupConfigInput): ResolvedBackupProfile {
  const name = inferProfileName(input);
  const configured = Boolean(input.BACKUP_S3_BUCKET);
  const hasKey = Boolean(input.BACKUP_S3_ACCESS_KEY);
  const hasSecret = Boolean(input.BACKUP_S3_SECRET_KEY);

  // Off-site is REQUIRED in production by default; the operator may force it
  // on elsewhere but may NOT turn it off in production (enforced below).
  const offsiteRequired = input.BACKUP_OFFSITE_REQUIRED ?? name === 'production';
  // Encryption is REQUIRED whenever a mode other than `none` is selected, and
  // production must select one (enforced below).
  const encryptionRequired = input.BACKUP_ENCRYPTION_MODE !== 'none';

  return {
    name,
    enabled: input.BACKUP_ENABLED,
    dir: input.BACKUP_DIR,
    offsite: {
      kind: configured ? 's3' : 'none',
      required: offsiteRequired,
      configured,
      credentialsComplete: hasKey === hasSecret,
    },
    encryption: {
      mode: input.BACKUP_ENCRYPTION_MODE,
      required: encryptionRequired,
      keyConfigured: Boolean(
        input.BACKUP_ENCRYPTION_KEYRING && input.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
      ),
      activeKeyId: input.BACKUP_ENCRYPTION_ACTIVE_KEY_ID ?? null,
    },
    timeouts: {
      dumpMs: input.BACKUP_DUMP_TIMEOUT_MS,
      uploadMs: input.BACKUP_UPLOAD_TIMEOUT_MS,
      restoreMs: input.BACKUP_RESTORE_TIMEOUT_MS,
    },
    objectives: {
      rpoHours: input.BACKUP_RPO_TARGET_HOURS,
      rtoMinutes: input.BACKUP_RTO_TARGET_MINUTES,
      restoreDrillIntervalHours: input.BACKUP_RESTORE_DRILL_INTERVAL_HOURS,
    },
    artifact: { minBytes: input.BACKUP_MIN_ARTIFACT_BYTES },
    retention: {
      localDays: input.BACKUP_RETENTION_LOCAL_DAYS,
      cloudDays: input.BACKUP_RETENTION_CLOUD_DAYS,
      dryRun: input.RETENTION_DRY_RUN,
    },
  };
}

/**
 * Fail-closed configuration validation (issue §1 "Em produção").
 *
 * Returns the list of blocking problems; an empty list means the profile is
 * usable. `env.ts` turns each entry into a Zod issue, so an invalid production
 * config refuses to BOOT rather than degrading to a warning at 03:00.
 *
 * Messages carry the variable NAME and the remediation, never the value —
 * `maia doctor` can print them verbatim without leaking a secret.
 */
export function validateBackupProfile(profile: ResolvedBackupProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const isProd = profile.name === 'production';

  // Backup itself may be disabled outside production (a laptop, a CI job).
  if (isProd && !profile.enabled) {
    issues.push({
      path: 'BACKUP_ENABLED',
      message:
        'BACKUP_ENABLED=false is not allowed in the production profile — a production deployment without backups has no recovery path.',
    });
  }

  if (!profile.enabled) return issues;

  // --- Off-site ---------------------------------------------------------
  if (isProd && !profile.offsite.required) {
    issues.push({
      path: 'BACKUP_OFFSITE_REQUIRED',
      message:
        'BACKUP_OFFSITE_REQUIRED=false is not allowed in the production profile — losing the host would take the only artifact with it.',
    });
  }
  if (profile.offsite.required && !profile.offsite.configured) {
    issues.push({
      path: 'BACKUP_S3_BUCKET',
      message:
        'off-site backup is required by this profile but no destination is configured. Set BACKUP_S3_BUCKET (and credentials) or switch to a profile that does not require off-site.',
    });
  }
  if (!profile.offsite.credentialsComplete) {
    issues.push({
      path: 'BACKUP_S3_ACCESS_KEY',
      message:
        'partial S3 credentials: set BOTH BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY, or NEITHER (to use an instance role).',
    });
  }

  // --- Encryption -------------------------------------------------------
  if (isProd && profile.encryption.mode === 'none') {
    issues.push({
      path: 'BACKUP_ENCRYPTION_MODE',
      message:
        'BACKUP_ENCRYPTION_MODE=none is not allowed in the production profile — a dump contains every tenant\'s personal data in the clear.',
    });
  }
  if (profile.encryption.required && !profile.encryption.keyConfigured) {
    issues.push({
      path: 'BACKUP_ENCRYPTION_KEYRING',
      message:
        'encryption is required but the keyring is incomplete. Set BACKUP_ENCRYPTION_KEYRING (JSON {key_id: base64(32 bytes)}) and BACKUP_ENCRYPTION_ACTIVE_KEY_ID. The run fails closed rather than writing a plaintext dump.',
    });
  }

  // --- Objectives -------------------------------------------------------
  // Do not let the deployment PROMISE an RPO the schedule cannot meet
  // (issue §8 "não declarar RPO incompatível com a arquitetura"). The nightly
  // cadence is 24h, so an RPO target below that needs PITR/WAL archiving,
  // which this issue explicitly leaves as a planned sub-scope.
  if (profile.objectives.rpoHours < 24) {
    issues.push({
      path: 'BACKUP_RPO_TARGET_HOURS',
      message:
        'BACKUP_RPO_TARGET_HOURS below 24 cannot be met by nightly logical dumps alone. Either raise the target or land PITR/WAL archiving first — the platform must not advertise an RPO it cannot honour.',
    });
  }

  if (profile.retention.localDays > profile.retention.cloudDays && profile.offsite.required) {
    issues.push({
      path: 'BACKUP_RETENTION_CLOUD_DAYS',
      message:
        'cloud retention is shorter than local retention while off-site is required — the authoritative copy would expire before the local one.',
    });
  }

  return issues;
}
