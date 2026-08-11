/**
 * Issue #520 §1 — the backup fail-closed rules, now living in the #515
 * contract (`src/config/rules.ts`, rule family `backup/*`).
 *
 * These are BOOT-scope: a production host whose backup configuration can only
 * ever produce an unrecoverable or plaintext artifact must not start. The
 * issue is explicit — "configuração inválida não pode ser reduzida a warning
 * silencioso".
 *
 * Every case starts from the profile's own fixture (a configuration that is
 * valid by construction) and breaks exactly one thing, so a failure here names
 * the rule that fired rather than a pile of unrelated requirements.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { formatHuman, validateConfig } from '@/config/validate.js';
import type { MaiaProfile } from '@/config/metadata.js';

function envFor(
  profile: MaiaProfile,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...buildFixture(profile), ...overrides };
}

function check(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return validateConfig({
    env: envFor(profile, overrides),
    profile,
    allowSyntheticFixtures: true,
  });
}

const errorRules = (r: ReturnType<typeof check>) => r.errors.map((p) => p.rule);
const warningRules = (r: ReturnType<typeof check>) => r.warnings.map((p) => p.rule);

describe('backup rules — the baseline production posture is accepted', () => {
  it.each(['development', 'staging', 'production'] as const)(
    'the %s fixture triggers no backup rule',
    (profile) => {
      const r = check(profile);
      expect(r.errors, formatHuman(r)).toEqual([]);
      expect(errorRules(r).filter((x) => x.startsWith('backup/'))).toEqual([]);
    },
  );
});

describe('backup/production-enabled', () => {
  it('refuses BACKUP_ENABLED=false in production', () => {
    expect(errorRules(check('production', { BACKUP_ENABLED: 'false' }))).toContain(
      'backup/production-enabled',
    );
  });

  it('allows backups to be disabled outside production', () => {
    const r = check('development', { BACKUP_ENABLED: 'false' });
    expect(errorRules(r).filter((x) => x.startsWith('backup/'))).toEqual([]);
  });

  it('stops evaluating the other backup rules once backups are off', () => {
    // A disabled backup with no destination is not a finding — it is a
    // deliberate choice, and piling on would bury the one thing that matters.
    const r = check('development', {
      BACKUP_ENABLED: 'false',
      BACKUP_S3_BUCKET: undefined,
      BACKUP_OFFSITE_REQUIRED: 'true',
    });
    expect(errorRules(r)).not.toContain('backup/offsite-destination');
  });
});

describe('backup/production-offsite-required + backup/offsite-destination', () => {
  it('refuses an operator turning the off-site requirement off in production', () => {
    expect(errorRules(check('production', { BACKUP_OFFSITE_REQUIRED: 'false' }))).toContain(
      'backup/production-offsite-required',
    );
  });

  it('refuses production without a destination', () => {
    expect(
      errorRules(
        check('production', {
          BACKUP_S3_BUCKET: undefined,
          BACKUP_S3_ACCESS_KEY: undefined,
          BACKUP_S3_SECRET_KEY: undefined,
        }),
      ),
    ).toContain('backup/offsite-destination');
  });

  it('refuses an opt-IN off-site requirement with no destination, in any profile', () => {
    expect(
      errorRules(
        check('development', {
          BACKUP_OFFSITE_REQUIRED: 'true',
          BACKUP_S3_BUCKET: undefined,
          BACKUP_S3_ACCESS_KEY: undefined,
          BACKUP_S3_SECRET_KEY: undefined,
        }),
      ),
    ).toContain('backup/offsite-destination');
  });

  it('accepts local-only when the profile does not require off-site', () => {
    const r = check('development', {
      BACKUP_OFFSITE_REQUIRED: undefined,
      BACKUP_S3_BUCKET: undefined,
      BACKUP_S3_ACCESS_KEY: undefined,
      BACKUP_S3_SECRET_KEY: undefined,
    });
    expect(errorRules(r).filter((x) => x.startsWith('backup/'))).toEqual([]);
  });
});

describe('backup/production-encryption + backup/encryption-key', () => {
  it('refuses a plaintext dump in production', () => {
    expect(
      errorRules(
        check('production', {
          BACKUP_ENCRYPTION_MODE: 'none',
          BACKUP_ENCRYPTION_KEYRING: undefined,
          BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined,
        }),
      ),
    ).toContain('backup/production-encryption');
  });

  it('refuses encryption without a keyring', () => {
    expect(errorRules(check('production', { BACKUP_ENCRYPTION_KEYRING: undefined }))).toContain(
      'backup/encryption-key',
    );
  });

  it('refuses encryption without an active key id', () => {
    expect(
      errorRules(check('production', { BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined })),
    ).toContain('backup/encryption-key');
  });

  it('applies the keyring requirement outside production too', () => {
    expect(
      errorRules(
        check('development', {
          BACKUP_ENCRYPTION_MODE: 'envelope_aes256_gcm',
          BACKUP_ENCRYPTION_KEYRING: undefined,
          BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined,
        }),
      ),
    ).toContain('backup/encryption-key');
  });

  it('never echoes key material in the message or the remediation', () => {
    const r = check('production', { BACKUP_ENCRYPTION_ACTIVE_KEY_ID: undefined });
    const body = JSON.stringify(r.errors) + JSON.stringify(r.warnings);
    expect(body).not.toContain('AAAAAAAA');
  });
});

describe('backup/rpo-feasible', () => {
  it('refuses to promise an RPO the nightly cadence cannot meet', () => {
    expect(errorRules(check('production', { BACKUP_RPO_TARGET_HOURS: '4' }))).toContain(
      'backup/rpo-feasible',
    );
  });

  it('accepts exactly 24h', () => {
    expect(errorRules(check('production', { BACKUP_RPO_TARGET_HOURS: '24' }))).not.toContain(
      'backup/rpo-feasible',
    );
  });
});

describe('backup/retention-ordering', () => {
  it('refuses the authoritative copy expiring before the local one', () => {
    expect(
      errorRules(
        check('production', {
          BACKUP_RETENTION_LOCAL_DAYS: '60',
          BACKUP_RETENTION_CLOUD_DAYS: '30',
        }),
      ),
    ).toContain('backup/retention-ordering');
  });

  it('does not apply when off-site is not required (no authoritative remote copy)', () => {
    expect(
      errorRules(
        check('development', {
          BACKUP_OFFSITE_REQUIRED: undefined,
          BACKUP_RETENTION_LOCAL_DAYS: '60',
          BACKUP_RETENTION_CLOUD_DAYS: '30',
        }),
      ),
    ).not.toContain('backup/retention-ordering');
  });
});

describe('retention/dry-run-disabled', () => {
  it('warns — loudly but without blocking — when deletion is armed', () => {
    const r = check('production', { RETENTION_DRY_RUN: 'false' });
    expect(warningRules(r)).toContain('retention/dry-run-disabled');
    expect(errorRules(r)).not.toContain('retention/dry-run-disabled');
  });

  it('stays quiet under the safe default', () => {
    expect(warningRules(check('production'))).not.toContain('retention/dry-run-disabled');
  });

  it('keeps the dry-run on for any value that is not an explicit disable', () => {
    // `boolFlag` semantics would turn `yes` into false and ARM deletion. The
    // inverted schema keeps the dry-run on unless told `false`/`0` exactly.
    expect(warningRules(check('production', { RETENTION_DRY_RUN: 'yes' }))).not.toContain(
      'retention/dry-run-disabled',
    );
    expect(warningRules(check('production', { RETENTION_DRY_RUN: '0' }))).toContain(
      'retention/dry-run-disabled',
    );
  });
});

describe('a typo in a destructive knob fails closed', () => {
  it('rejects RETENTION_DRYRUN as an unknown Maia variable', () => {
    // The `RETENTION_` namespace was added to MAIA_KEY_PREFIXES precisely so a
    // typo cannot silently leave the dry-run on while the operator believes it
    // is off (or vice versa).
    const r = check('production', { RETENTION_DRYRUN: 'false' });
    expect(errorRules(r)).toContain('contract/unknown');
  });
});
