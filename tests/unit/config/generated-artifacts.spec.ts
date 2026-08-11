/**
 * Issue #515 — golden tests for the GENERATED configuration artifacts.
 *
 * `.env.example`, `docs/configuration.md`, the JSON Schema, the per-service
 * manifest and the per-profile fixtures are produced by
 * `npm run config:generate`. These tests are the local mirror of the CI drift
 * check (`npm run config:check:drift`): if the contract changes and the
 * artifacts are not regenerated, the suite fails here first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildJsonSchema,
  parseEnvFile,
  renderConfigDoc,
  renderEnvExample,
  renderFixture,
} from '@/config/generate.js';
import { buildServiceManifest } from '@/config/services.js';
import { MAIA_PROFILES, type MaiaProfile } from '@/config/metadata.js';
import { formatHuman, validateConfig } from '@/config/validate.js';

const REPO_ROOT = resolve(__dirname, '../../..');
/**
 * Normalised read: the repo has no `.gitattributes` and Windows checkouts run
 * with `core.autocrlf=true`, so a committed LF artifact lands on disk as CRLF.
 * Artifacts are always WRITTEN with LF, so comparing normalised text keeps the
 * golden assertion meaningful on every platform.
 */
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const STALE =
  'artefato gerado desatualizado — rode `npm run config:generate` e commite o resultado';

describe('generated artifacts — no drift (#515)', () => {
  it('.env.example matches the contract', () => {
    expect(read('.env.example'), STALE).toBe(renderEnvExample());
  });

  it('docs/configuration.md matches the contract', () => {
    expect(read('docs/configuration.md'), STALE).toBe(renderConfigDoc());
  });

  it('the JSON Schema matches the contract', () => {
    expect(read('src/config/generated/env-schema.json'), STALE).toBe(
      `${JSON.stringify(buildJsonSchema(), null, 2)}\n`,
    );
  });

  it('the per-service manifest matches the contract', () => {
    expect(read('src/config/generated/service-env-manifest.json'), STALE).toBe(
      `${JSON.stringify(buildServiceManifest(MAIA_PROFILES), null, 2)}\n`,
    );
  });

  it.each(MAIA_PROFILES)('the %s fixture matches the contract', (profile) => {
    expect(read(`src/config/generated/fixtures/${profile}.env`), STALE).toBe(
      renderFixture(profile),
    );
  });
});

describe('generated artifacts — semantics (#515)', () => {
  it('.env.example passes structural validation in development', () => {
    const env = parseEnvFile(read('.env.example'));
    const result = validateConfig({
      env,
      profile: 'development',
      allowPlaceholders: true,
    });
    expect(result.errors, formatHuman(result)).toEqual([]);
  });

  it('.env.example contains no variable without a consumer', () => {
    const env = parseEnvFile(read('.env.example'));
    const result = validateConfig({ env, profile: 'production', allowPlaceholders: true });
    expect(result.errors.filter((p) => p.rule === 'contract/unknown')).toEqual([]);
    expect(result.warnings.filter((p) => p.rule === 'contract/unknown')).toEqual([]);
  });

  it('.env.example no longer documents the removed multi-channel flag as live', () => {
    const env = parseEnvFile(read('.env.example'));
    expect(env.FEATURE_MULTI_CHANNEL).toBeUndefined();
    expect(env.APROVAR_MENSAGENS_PROATIVAS).toBeUndefined();
    // It is still DOCUMENTED, as a tombstone, so an operator who greps for it
    // finds out it was removed instead of finding nothing.
    expect(read('.env.example')).toContain('FEATURE_MULTI_CHANNEL — removida em PR #411');
  });

  it.each(MAIA_PROFILES)(
    'the %s fixture satisfies every rule of its profile (contract is satisfiable)',
    (profile) => {
      const env = parseEnvFile(read(`src/config/generated/fixtures/${profile}.env`));
      const result = validateConfig({
        env,
        profile: profile as MaiaProfile,
        allowSyntheticFixtures: true,
      });
      expect(result.errors, formatHuman(result)).toEqual([]);
    },
  );

  it.each(['staging', 'production'] as const)(
    'the %s fixture file is REJECTED without the explicit --allow-fixtures opt-in',
    (profile) => {
      // The footgun the review found: `config init` used to write this file as
      // `.env`, and the recommended `config check` said it was fine.
      const env = parseEnvFile(read(`src/config/generated/fixtures/${profile}.env`));
      const result = validateConfig({ env, profile });
      expect(result.ok).toBe(false);
      expect(result.errors.some((p) => p.rule === 'secret/synthetic-fixture')).toBe(true);
    },
  );

  it('the fixture files warn, in the file itself, against being used as a .env', () => {
    for (const profile of MAIA_PROFILES) {
      const content = read(`src/config/generated/fixtures/${profile}.env`);
      expect(content).toContain('NÃO USE COMO .env');
      expect(content).toContain('config:init');
    }
  });

  it('no generated artifact contains anything shaped like a real credential', () => {
    // Provider key shapes that a real credential would match. The synthetic
    // fixtures use short `fixture-*` literals precisely so this holds.
    const REAL_KEY_SHAPES = [
      /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/,
      /sk-or-v1-[A-Za-z0-9_-]{20,}/,
      /sk-proj-[A-Za-z0-9_-]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /\bghp_[A-Za-z0-9]{30,}/,
    ];
    const artifacts = [
      '.env.example',
      'docs/configuration.md',
      'src/config/generated/env-schema.json',
      'src/config/generated/service-env-manifest.json',
      ...MAIA_PROFILES.map((p) => `src/config/generated/fixtures/${p}.env`),
    ];
    for (const path of artifacts) {
      const content = read(path);
      for (const shape of REAL_KEY_SHAPES) {
        expect(shape.test(content), `${path} matches ${shape}`).toBe(false);
      }
    }
  });

  it('the JSON Schema never publishes an example for a secret', () => {
    const schema = buildJsonSchema() as {
      properties: Record<string, { 'x-maia-secret': boolean; examples?: unknown }>;
    };
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (prop['x-maia-secret']) {
        expect(prop.examples, `${name} must not publish an example value`).toBeUndefined();
      }
    }
  });

  it('the manifest answers "which variables belong to this service"', () => {
    const manifest = buildServiceManifest(MAIA_PROFILES) as {
      services: Record<string, { secrets: string[]; by_profile: Record<string, { required: string[] }> }>;
    };
    expect(Object.keys(manifest.services).sort()).toEqual(
      ['admin-ui', 'backup', 'maintenance', 'migrator', 'runtime'].sort(),
    );
    expect(manifest.services.migrator!.by_profile.production!.required).toContain('DATABASE_URL');
    expect(manifest.services.migrator!.secrets).not.toContain('ANTHROPIC_API_KEY');
  });
});
