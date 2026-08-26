/**
 * Issue #520 §1 — the backup/restore configuration contract.
 *
 * Baseline gap: retention + S3 knobs existed, but nothing stated what a given
 * ENVIRONMENT *requires*. S3 was optional everywhere, so a production host
 * silently ran local-only forever.
 *
 * DIVISION OF LABOUR WITH #515. The variables are declared in
 * `src/config/contract.ts` and the fail-closed VERDICTS ("production without an
 * off-site destination must not boot") live in `src/config/rules.ts`, under the
 * `backup/*` rule family. This module only RESOLVES: given the already-coerced
 * values and the Maia profile, what is required and what is configured. It does
 * not re-implement a single rule, so the boot gate and the readiness view
 * cannot drift.
 *
 * There is deliberately NO `BACKUP_PROFILE`: the profile is `MAIA_ENV`
 * (`src/config/profiles.ts`). A second profile selector scoped to backup would
 * be exactly the second source of truth this reconciliation exists to avoid.
 *
 * PURE — takes a plain record, imports no config singleton, so every profile
 * can be exercised in unit tests without touching `process.env`.
 */
import type { MaiaProfile } from '@/config/metadata.js';

export type BackupProfileName = MaiaProfile;
export type EncryptionMode = 'none' | 'envelope_aes256_gcm';
export type OffsiteKind = 'none' | 's3';

/**
 * Already-coerced slice of the contract this module understands, plus the
 * resolved Maia profile. Every field name matches a contract variable, so a
 * rename in `contract.ts` breaks this at compile time.
 */
export interface BackupConfigInput {
  /** Resolved Maia profile — `resolveProfile()`, never inferred locally. */
  profile: MaiaProfile;
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

export function resolveBackupProfile(input: BackupConfigInput): ResolvedBackupProfile {
  const name = input.profile;
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
 * WHERE THE FAIL-CLOSED VERDICTS LIVE.
 *
 * A `validateBackupProfile()` used to sit here and was called from the
 * pre-contract `env.ts` `superRefine`. After #515 it would be a SECOND
 * implementation of rules the contract validator already owns, and two copies
 * of a boot gate drift. The verdicts now live in `src/config/rules.ts` as the
 * `backup/*` rule family, evaluated at boot AND by `maia config check` /
 * `maia doctor`:
 *
 *   backup/production-enabled          BACKUP_ENABLED=false em production
 *   backup/production-offsite-required BACKUP_OFFSITE_REQUIRED=false em production
 *   backup/offsite-destination         off-site exigido sem BACKUP_S3_BUCKET
 *   backup/production-encryption       BACKUP_ENCRYPTION_MODE=none em production
 *   backup/encryption-key              cifra exigida sem keyring/key id
 *   backup/rpo-feasible                BACKUP_RPO_TARGET_HOURS < 24
 *   backup/drill-interval-feasible     intervalo do drill menor que o piso que
 *                                      o agendador consegue honrar (#536)
 *   backup/retention-ordering          retenção cloud < local com off-site exigido
 *   backup/s3-credentials              bucket sem credenciais (regra da #515)
 *
 * This module keeps only the RESOLUTION (`resolveBackupProfile` above), which
 * the runner and the readiness evaluator both consume.
 */
