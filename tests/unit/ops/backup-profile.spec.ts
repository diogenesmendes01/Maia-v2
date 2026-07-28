import { describe, it, expect } from 'vitest';
import {
  resolveBackupProfile,
  validateBackupProfile,
  inferProfileName,
  type BackupConfigInput,
} from '../../../src/ops/backup/profile.js';

/**
 * Issue #520 §1 — "Em produção: ausência de destino off-site obrigatório falha
 * readiness; combinação parcial de credenciais falha validação; criptografia
 * exigida sem chave válida falha fechado; configuração inválida não pode ser
 * reduzida a warning silencioso."
 */

function input(over: Partial<BackupConfigInput> = {}): BackupConfigInput {
  return {
    NODE_ENV: 'development',
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
    NODE_ENV: 'production',
    BACKUP_S3_BUCKET: 'maia-backups',
    BACKUP_S3_ACCESS_KEY: 'ak',
    BACKUP_S3_SECRET_KEY: 'sk',
    BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
    BACKUP_ENCRYPTION_KEYRING: '{"k1":"' + 'A'.repeat(43) + '="}',
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    ...over,
  });
}

function paths(cfg: BackupConfigInput): string[] {
  return validateBackupProfile(resolveBackupProfile(cfg)).map((i) => i.path);
}

describe('inferProfileName', () => {
  it('maps NODE_ENV=production to the production profile', () => {
    expect(inferProfileName(input({ NODE_ENV: 'production' }))).toBe('production');
  });

  it('maps test/development to the development profile', () => {
    expect(inferProfileName(input({ NODE_ENV: 'test' }))).toBe('development');
  });

  it('honours an explicit override', () => {
    expect(inferProfileName(input({ BACKUP_PROFILE: 'staging' }))).toBe('staging');
  });
});

describe('resolveBackupProfile', () => {
  it('requires off-site by default in production only', () => {
    expect(resolveBackupProfile(prod()).offsite.required).toBe(true);
    expect(resolveBackupProfile(input()).offsite.required).toBe(false);
  });

  it('treats any non-none encryption mode as required', () => {
    expect(resolveBackupProfile(prod()).encryption.required).toBe(true);
    expect(resolveBackupProfile(input()).encryption.required).toBe(false);
  });

  it('never exposes key material — only the active key id', () => {
    const p = resolveBackupProfile(prod());
    expect(p.encryption.activeKeyId).toBe('k1');
    expect(JSON.stringify(p)).not.toContain('AAAA');
  });
});

describe('validateBackupProfile — production fails closed', () => {
  it('accepts a fully-configured production profile', () => {
    expect(paths(prod())).toEqual([]);
  });

  it('rejects production without an off-site destination', () => {
    expect(paths(prod({ BACKUP_S3_BUCKET: undefined }))).toContain('BACKUP_S3_BUCKET');
  });

  it('rejects an operator turning off the off-site requirement in production', () => {
    expect(paths(prod({ BACKUP_OFFSITE_REQUIRED: false }))).toContain('BACKUP_OFFSITE_REQUIRED');
  });

  it('rejects partial S3 credentials', () => {
    expect(paths(prod({ BACKUP_S3_SECRET_KEY: undefined }))).toContain('BACKUP_S3_ACCESS_KEY');
  });

  it('accepts NEITHER credential (instance role)', () => {
    expect(
      paths(prod({ BACKUP_S3_ACCESS_KEY: undefined, BACKUP_S3_SECRET_KEY: undefined })),
    ).toEqual([]);
  });

  it('rejects plaintext backups in production', () => {
    expect(paths(prod({ BACKUP_ENCRYPTION_MODE: 'none' }))).toContain('BACKUP_ENCRYPTION_MODE');
  });

  it('rejects encryption required without a usable keyring', () => {
    expect(paths(prod({ BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined }))).toContain(
      'BACKUP_ENCRYPTION_KEYRING',
    );
  });

  it('rejects disabling backups in production', () => {
    expect(paths(prod({ BACKUP_ENABLED: false }))).toContain('BACKUP_ENABLED');
  });

  it('refuses to promise an RPO the nightly cadence cannot meet', () => {
    expect(paths(prod({ BACKUP_RPO_TARGET_HOURS: 1 }))).toContain('BACKUP_RPO_TARGET_HOURS');
  });

  it('rejects cloud retention shorter than local when off-site is authoritative', () => {
    expect(
      paths(prod({ BACKUP_RETENTION_LOCAL_DAYS: 60, BACKUP_RETENTION_CLOUD_DAYS: 30 })),
    ).toContain('BACKUP_RETENTION_CLOUD_DAYS');
  });

  it('never quotes a secret value in a remediation message', () => {
    const issues = validateBackupProfile(
      resolveBackupProfile(prod({ BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined })),
    );
    for (const i of issues) expect(i.message).not.toContain('AAAA');
  });
});

describe('validateBackupProfile — development stays usable', () => {
  it('accepts a bare local-only development profile', () => {
    expect(paths(input())).toEqual([]);
  });

  it('allows backups to be disabled outside production', () => {
    expect(paths(input({ BACKUP_ENABLED: false }))).toEqual([]);
  });
});
