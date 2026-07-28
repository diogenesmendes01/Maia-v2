/**
 * Issue #515 — per-service loaders.
 *
 * This is the interface the migration runner (#516) and `maia doctor` (#517)
 * consume, so it is pinned here: a service gets ONLY its declared subset, an
 * invalid environment throws with EVERY problem attached (not just the first),
 * and nothing in the loader path mutates `process.env`.
 */
import { describe, it, expect } from 'vitest';
import { ConfigValidationError, bootSummary, loadServiceConfig } from '@/config/load.js';
import { loadMigrationConfig, migrationManifest } from '@/config/migration-config.js';
import { loadBackupConfig } from '@/config/backup-config.js';
import { loadAdminConfig } from '@/config/admin-config.js';
import { assertServiceMayRead, manifestForService } from '@/config/services.js';
import { buildFixture } from '@/config/generate.js';

const PROD = () => buildFixture('production');

/**
 * The fixtures are SYNTHETIC (`sk-ant-fixture-…`). A real environment carrying
 * those values is rejected by `secret/synthetic-fixture` — that is the point of
 * PR #522 review round 1 [P1]. Loading them here IS the satisfiability proof,
 * so the opt-in is explicit and shared by the cases below.
 */
const FIXTURE_OPTS = { profile: 'production', allowSyntheticFixtures: true } as const;

describe('service loaders (#515)', () => {
  it('the migrator receives Postgres + core knobs and nothing else', () => {
    const cfg = loadMigrationConfig({ env: PROD(), ...FIXTURE_OPTS });
    expect(cfg.DATABASE_URL).toContain('postgres://');
    expect(cfg.POSTGRES_DB).toBe('maia');
    expect('ANTHROPIC_API_KEY' in cfg).toBe(false);
    expect('BAILEYS_AUTH_DIR' in cfg).toBe(false);
    expect('NEXTAUTH_SECRET' in cfg).toBe(false);
  });

  it('the backup loader receives the S3 destination and the alert transport', () => {
    const cfg = loadBackupConfig({ env: PROD(), ...FIXTURE_OPTS });
    expect(cfg.BACKUP_S3_BUCKET).toBe('maia-backups');
    expect(cfg.ALERT_CHANNELS).toEqual(['log']);
    expect('WHATSAPP_NUMBER_MAIA' in cfg).toBe(false);
  });

  it('the admin loader receives NextAuth/OIDC and not the WhatsApp session', () => {
    const cfg = loadAdminConfig({ env: PROD(), ...FIXTURE_OPTS });
    expect(cfg.NEXTAUTH_URL).toContain('https://');
    expect(cfg.OIDC_TENANT_SLUGS).toBe('primary');
    expect('BAILEYS_AUTH_DIR' in cfg).toBe(false);
  });

  it('the runtime loader parses coerced numbers, booleans and the alert list', () => {
    const cfg = loadServiceConfig('runtime', { env: PROD(), ...FIXTURE_OPTS });
    expect(cfg.APP_PORT).toBe(3000);
    expect(cfg.FEATURE_PROCEDURE_RUNTIME).toBe(true);
    expect(cfg.FEATURE_MCP_TOOLS).toBe(false);
    expect(cfg.ALERT_CHANNELS).toEqual(['log']);
    expect(cfg.VALOR_DUAL_APPROVAL).toBe(5000);
  });

  it('throws ConfigValidationError carrying EVERY problem, not just the first', () => {
    let caught: unknown;
    try {
      loadServiceConfig('migrator', { env: {}, profile: 'production' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const error = caught as ConfigValidationError;
    expect(error.service).toBe('migrator');
    expect(error.profile).toBe('production');
    expect(error.problems.length).toBeGreaterThan(2);
    for (const p of error.problems) {
      expect(p.remediation.length).toBeGreaterThan(0);
    }
  });

  it('never echoes a secret value in the thrown message', () => {
    const CANARY = 'sk-ant-CANARY-loader-do-not-leak';
    let message = '';
    try {
      loadServiceConfig('runtime', {
        env: { ...PROD(), LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: CANARY },
        profile: 'production',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes(CANARY)).toBe(false);
  });

  it('loading does not mutate the caller environment', () => {
    const env = PROD();
    const before = JSON.stringify(env);
    loadServiceConfig('runtime', { env, ...FIXTURE_OPTS });
    expect(JSON.stringify(env)).toBe(before);
  });

  it('`validate: false` degrades to a schema-only parse (rollback lever)', () => {
    // A tombstoned variable is an ERROR in production under full validation…
    expect(() =>
      loadServiceConfig('migrator', {
        env: { ...PROD(), FEATURE_MULTI_CHANNEL: 'false' },
        profile: 'production',
      }),
    ).toThrow(ConfigValidationError);
    // …and tolerated when the operator explicitly drops back to schema-only.
    expect(() =>
      loadServiceConfig('migrator', {
        env: { ...PROD(), FEATURE_MULTI_CHANNEL: 'false' },
        profile: 'production',
        validate: false,
      }),
    ).not.toThrow();
  });

  it('bootSummary emits profile/version/hash/warning count and no secret', () => {
    const summary = bootSummary('runtime', { env: PROD(), ...FIXTURE_OPTS });
    expect(summary).toEqual({
      service: 'runtime',
      profile: 'production',
      contract_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      config_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      warnings: expect.any(Number),
    });
    expect(JSON.stringify(summary)).not.toContain('fixture-');
  });
});

describe('service manifests (#515)', () => {
  it('assertServiceMayRead refuses a variable the service does not declare', () => {
    expect(() => assertServiceMayRead('runtime', 'DATABASE_URL')).not.toThrow();
    expect(() => assertServiceMayRead('migrator', 'ANTHROPIC_API_KEY')).toThrow(
      /não declara a variável "ANTHROPIC_API_KEY"/,
    );
  });

  it('the manifest marks the variables the profile actually requires', () => {
    const manifest = migrationManifest('production');
    const required = manifest.variables.filter((v) => v.required).map((v) => v.name);
    expect(required).toContain('DATABASE_URL');
    expect(required).toContain('MAIA_ENV');
    expect(manifest.secrets).toContain('DATABASE_URL');
    expect(manifest.secrets).not.toContain('POSTGRES_DB');
  });

  it('development requires fewer variables than production', () => {
    const dev = manifestForService('runtime', 'development').variables.filter((v) => v.required);
    const prod = manifestForService('runtime', 'production').variables.filter((v) => v.required);
    expect(prod.length).toBeGreaterThan(dev.length);
  });
});
