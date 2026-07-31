/**
 * Issue #536 — `retention/tombstone-exceeds-backup`, BOOT scope.
 *
 * This is the rule that turns the tombstone invariant from a paragraph in the
 * retention matrix into something a deploy cannot get past. The cases below
 * start from each profile's own fixture (valid by construction) and break
 * exactly one thing, so a failure names the rule rather than a pile of
 * unrelated requirements — same shape as `backup-rules.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { formatHuman, validateConfig } from '@/config/validate.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import type { MaiaProfile } from '@/config/metadata.js';
import { DEFAULT_TOMBSTONE_MIN_DAYS } from '@/ops/retention/tombstone-floor.js';

function check(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return validateConfig({
    env: { ...buildFixture(profile), ...overrides },
    profile,
    allowSyntheticFixtures: true,
  });
}

const errorRules = (r: ReturnType<typeof check>) => r.errors.map((p) => p.rule);
const findingFor = (r: ReturnType<typeof check>, rule: string) =>
  [...r.errors, ...r.warnings].find((p) => p.rule === rule);

describe('the shipped posture already satisfies the invariant', () => {
  it.each(['development', 'staging', 'production'] as const)(
    'the %s fixture triggers no retention rule',
    (profile) => {
      const r = check(profile);
      expect(r.errors, formatHuman(r)).toEqual([]);
      expect(errorRules(r).filter((x) => x.startsWith('retention/'))).toEqual([]);
    },
  );

  it('ships the floor the owner proposed', () => {
    expect(buildFixture('production').RETENTION_TOMBSTONE_MIN_DAYS).toBe(
      String(DEFAULT_TOMBSTONE_MIN_DAYS),
    );
  });
});

describe('retention/tombstone-exceeds-backup', () => {
  it('BLOCKS the boot when off-site retention is raised past the tombstone floor', () => {
    // THE scenario the rule exists for: a one-line change to the off-site
    // window silently reopens resurrection. 60-day floor, 90-day artifacts.
    const r = check('production', { BACKUP_RETENTION_CLOUD_DAYS: '90' });
    expect(errorRules(r)).toContain('retention/tombstone-exceeds-backup');
    expect(findingFor(r, 'retention/tombstone-exceeds-backup')?.severity).toBe('error');
  });

  it('is BOOT scope — it stops the process, not just `maia config check`', () => {
    // `ConfigProblem` carries no scope, so the assertion goes to the rule
    // evaluator itself. Boot scope is the load-bearing part of this rule: a
    // contract-scope finding would be a report someone reads after the restore.
    const findings = evaluateCrossFieldRules({
      values: {
        RETENTION_TOMBSTONE_MIN_DAYS: 60,
        BACKUP_RETENTION_LOCAL_DAYS: 7,
        BACKUP_RETENTION_CLOUD_DAYS: 90,
      },
      raw: {},
      profile: 'production',
    });
    const finding = findings.find((f) => f.rule === 'retention/tombstone-exceeds-backup');
    expect(finding?.scope).toBe('boot');
    expect(finding?.severity).toBe('error');
    expect(finding?.variable).toBe('RETENTION_TOMBSTONE_MIN_DAYS');
  });

  it('names the remedy with the smallest floor that would work', () => {
    const finding = findingFor(
      check('production', { BACKUP_RETENTION_CLOUD_DAYS: '90' }),
      'retention/tombstone-exceeds-backup',
    );
    expect(finding?.message).toContain('90');
    expect(finding?.remediation).toContain('91');
  });

  it('clears once the floor follows the backup window', () => {
    const r = check('production', {
      BACKUP_RETENTION_CLOUD_DAYS: '90',
      RETENTION_TOMBSTONE_MIN_DAYS: '91',
    });
    expect(errorRules(r)).not.toContain('retention/tombstone-exceeds-backup');
  });

  it('refuses an EQUAL pair — same-day expiry is still a resurrection window', () => {
    expect(
      errorRules(check('production', { RETENTION_TOMBSTONE_MIN_DAYS: '30' })),
    ).toContain('retention/tombstone-exceeds-backup');
  });

  it('also fires when the LOCAL window is the long one', () => {
    expect(
      errorRules(
        check('production', {
          BACKUP_RETENTION_LOCAL_DAYS: '365',
          BACKUP_RETENTION_CLOUD_DAYS: '365',
        }),
      ),
    ).toContain('retention/tombstone-exceeds-backup');
  });

  it('fires with backups DISABLED too — artifacts already retained do not vanish', () => {
    // Deliberately outside the `backupEnabled` guard the other backup rules
    // use: turning the job off stops new artifacts, not the old ones, so the
    // resurrection window is still open.
    const r = check('development', {
      BACKUP_ENABLED: 'false',
      BACKUP_RETENTION_CLOUD_DAYS: '120',
    });
    expect(errorRules(r)).toContain('retention/tombstone-exceeds-backup');
  });

  it('fires in every profile — resurrection is not a production-only defect', () => {
    for (const profile of ['development', 'staging', 'production'] as const) {
      expect(
        errorRules(check(profile, { BACKUP_RETENTION_CLOUD_DAYS: '120' })),
        profile,
      ).toContain('retention/tombstone-exceeds-backup');
    }
  });
});
