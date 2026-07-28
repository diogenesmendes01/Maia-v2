/**
 * Issue #515 — contract validator.
 *
 * Covers the acceptance criteria that are about BEHAVIOUR rather than shape:
 * every problem reported in one run, per-profile requirements, cross-field
 * rules, unknown / deprecated / removed variables, the `NODE_ENV` × `MAIA_ENV`
 * contradiction, and the canary proving a secret value never escapes.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { formatHuman, formatJson, validateConfig } from '@/config/validate.js';
import { resolveProfile } from '@/config/profiles.js';
import type { EnvVarSpec, MaiaProfile } from '@/config/metadata.js';
import { z } from 'zod';

const PROFILES: MaiaProfile[] = ['development', 'staging', 'production'];

function envFor(profile: MaiaProfile, overrides: Record<string, string | undefined> = {}) {
  return { ...buildFixture(profile), ...overrides };
}

function rules(result: { errors: readonly { rule: string }[]; warnings: readonly { rule: string }[] }) {
  return {
    errors: result.errors.map((p) => p.rule),
    warnings: result.warnings.map((p) => p.rule),
  };
}

describe('validateConfig — per-profile fixtures (#515)', () => {
  for (const profile of PROFILES) {
    it(`the ${profile} fixture satisfies every rule of its profile`, () => {
      // `allowSyntheticFixtures` is the ONLY thing waived: the fixture proves
      // the contract is SATISFIABLE, and its values are deliberately synthetic
      // (`secret/synthetic-fixture` rejects them in a real environment).
      const result = validateConfig({
        env: envFor(profile),
        profile,
        allowSyntheticFixtures: true,
      });
      expect(result.errors, formatHuman(result)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.profile).toBe(profile);
    });
  }

  it.each(['staging', 'production'] as const)(
    'the %s fixture is REJECTED when it is used as a real environment',
    (profile) => {
      const result = validateConfig({ env: envFor(profile), profile });
      expect(result.ok, 'copiar uma fixture de CI para .env não pode passar').toBe(false);
      expect(result.errors.some((p) => p.rule === 'secret/synthetic-fixture')).toBe(true);
    },
  );

  it('an empty environment reports EVERY missing requirement, not just the first', () => {
    const result = validateConfig({ env: {}, profile: 'production' });
    const missing = result.errors.filter((p) => p.rule === 'profile/required').map((p) => p.variable);
    // MAIA_ENV, DATABASE_URL, POSTGRES_*, REDIS_URL, WHATSAPP/OWNER, backup, admin…
    expect(missing.length).toBeGreaterThan(8);
    // and every problem carries a remediation
    for (const p of [...result.errors, ...result.warnings]) {
      expect(p.remediation.length, `${p.variable}/${p.rule}`).toBeGreaterThan(0);
    }
  });

  it('reports the profile, contract version and a stable non-secret hash', () => {
    const a = validateConfig({ env: envFor('production'), profile: 'production' });
    const b = validateConfig({ env: envFor('production'), profile: 'production' });
    expect(a.configHash).toBe(b.configHash);
    expect(a.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rotating a SECRET does not change the config hash (secrets are excluded, not masked)', () => {
    const base = envFor('production');
    const rotated = { ...base, ANTHROPIC_API_KEY: 'sk-ant-fixture-rotated-key' };
    expect(validateConfig({ env: rotated, profile: 'production' }).configHash).toBe(
      validateConfig({ env: base, profile: 'production' }).configHash,
    );
  });
});

describe('validateConfig — profile semantics (#515)', () => {
  it('MAIA_ENV=production with NODE_ENV=development is a contradiction', () => {
    const resolved = resolveProfile({ MAIA_ENV: 'production', NODE_ENV: 'development' });
    expect(resolved.profile).toBe('production');
    expect(resolved.problems.map((p) => p.rule)).toContain('profile/node-env-contradiction');
  });

  it('MAIA_ENV absent derives the profile from NODE_ENV', () => {
    expect(resolveProfile({ NODE_ENV: 'production' }).profile).toBe('production');
    expect(resolveProfile({ NODE_ENV: 'test' }).profile).toBe('development');
    expect(resolveProfile({}).profile).toBe('development');
  });

  it('an invalid MAIA_ENV is reported, not silently coerced', () => {
    const resolved = resolveProfile({ MAIA_ENV: 'prod' });
    expect(resolved.profile).toBe('development');
    expect(resolved.problems.map((p) => p.rule)).toContain('profile/invalid');
  });

  it('staging accepts NODE_ENV=production (staging runs production-shaped code)', () => {
    expect(resolveProfile({ MAIA_ENV: 'staging', NODE_ENV: 'production' }).problems).toEqual([]);
  });

  it('dev auth is refused outside development', () => {
    const result = validateConfig({
      env: envFor('production', { ALLOW_DEV_AUTH: 'true' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('admin-ui/dev-auth-forbidden');
  });

  it('a placeholder value fails staging/production but is fine in development', () => {
    const prod = validateConfig({
      env: envFor('production', { NEXTAUTH_SECRET: '__SET_ME__rotate_me_please' }),
      profile: 'production',
    });
    expect(rules(prod).errors).toContain('secret/placeholder');

    const dev = validateConfig({
      env: envFor('development', { NEXTAUTH_SECRET: '__SET_ME__rotate_me_please' }),
      profile: 'development',
    });
    expect(rules(dev).errors).not.toContain('secret/placeholder');
  });

  it('--allow-placeholders switches the strict check off for structural runs', () => {
    const result = validateConfig({
      env: envFor('production', { NEXTAUTH_SECRET: '__SET_ME__rotate_me_please' }),
      profile: 'production',
      allowPlaceholders: true,
    });
    expect(rules(result).errors).not.toContain('secret/placeholder');
  });

  it('http URLs are refused outside development', () => {
    const result = validateConfig({
      env: envFor('production', { NEXTAUTH_URL: 'http://admin.example.com' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('url/https-required');
  });
});

describe('validateConfig — cross-field rules (#515)', () => {
  it('validates the order of the three financial thresholds', () => {
    const result = validateConfig({
      env: envFor('production', {
        VALOR_LIMITE_SEM_CONFIRMACAO: '9000',
        VALOR_DUAL_APPROVAL: '5000',
        VALOR_LIMITE_DURO: '10000',
      }),
      profile: 'production',
    });
    const problem = result.errors.find((p) => p.rule === 'governance/threshold-order');
    expect(problem).toBeDefined();
    expect(problem!.message).toContain('VALOR_LIMITE_SEM_CONFIRMACAO');
  });

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ] as const)('LLM_PROVIDER=%s requires %s', (provider, key) => {
    const result = validateConfig({
      env: envFor('production', {
        LLM_PROVIDER: provider,
        ANTHROPIC_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      }),
      profile: 'production',
    });
    expect(result.errors.some((p) => p.message.includes(key))).toBe(true);
  });

  it.each([
    ['voyage', 'VOYAGE_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['cohere', 'COHERE_API_KEY'],
  ] as const)('EMBEDDING_PROVIDER=%s requires %s', (provider, key) => {
    const result = validateConfig({
      env: envFor('production', {
        EMBEDDING_PROVIDER: provider,
        VOYAGE_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        COHERE_API_KEY: undefined,
      }),
      profile: 'production',
    });
    expect(result.errors.some((p) => p.message.includes(key))).toBe(true);
  });

  it('embedding dimensions must match the model', () => {
    const result = validateConfig({
      env: envFor('production', {
        EMBEDDING_PROVIDER: 'openai',
        EMBEDDING_MODEL: 'text-embedding-3-small',
        EMBEDDING_DIMENSIONS: '1024',
        OPENAI_API_KEY: 'sk-fixture-not-a-real-key',
      }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('embeddings/dimension-mismatch');
  });

  it('the telegram alert channel requires token and chat id', () => {
    const result = validateConfig({
      env: envFor('production', {
        ALERT_CHANNELS: 'telegram',
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_CHAT_ID: undefined,
      }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('alerts/telegram-credentials');
  });

  it('an S3 bucket without credentials is refused', () => {
    const result = validateConfig({
      env: envFor('production', {
        BACKUP_S3_ACCESS_KEY: undefined,
        BACKUP_S3_SECRET_KEY: undefined,
      }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('backup/s3-credentials');
  });

  it('multi-line routing cannot run in shadow mode', () => {
    const result = validateConfig({
      env: envFor('production', { MAIA_MULTI_LINE: 'true', MAIA_CHANNEL_ROUTING_MODE: 'shadow' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('routing/multi-line-mode');
  });

  it('strict routing requires the staging keyring', () => {
    const result = validateConfig({
      env: envFor('production', {
        MAIA_CHANNEL_ROUTING_MODE: 'strict',
        MAIA_STAGING_KEYRING: undefined,
        MAIA_STAGING_ACTIVE_KEY_ID: undefined,
      }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('routing/strict-requires-keyring');
  });

  it("OIDC_TENANT_SLUGS may never contain the 'default' literal", () => {
    const result = validateConfig({
      env: envFor('production', { OIDC_TENANT_SLUGS: 'primary,default' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('admin-ui/tenant-slugs-default-literal');
  });

  it('an unsafe BAILEYS_AUTH_DIR is refused', () => {
    const result = validateConfig({
      env: envFor('production', { BAILEYS_AUTH_DIR: '/etc' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('whatsapp/auth-dir-safe');
  });

  it('FEATURE_MCP_TOOLS cannot be enabled in production', () => {
    const result = validateConfig({
      env: envFor('production', { FEATURE_MCP_TOOLS: 'true' }),
      profile: 'production',
    });
    expect(rules(result).errors).toContain('mcp/production-forbidden');
  });
});

describe('validateConfig — unknown, deprecated and removed (#515)', () => {
  // Owner decision on PR #522 review round 1: fail-closed in EVERY profile.
  // A `.env` that boots on a laptop and dies in staging is the drift this
  // issue exists to remove, so `development` gets the same verdict.
  it.each(PROFILES)('a REMOVED variable is an error in %s', (profile) => {
    const result = validateConfig({
      env: envFor(profile, { FEATURE_MULTI_CHANNEL: 'false' }),
      profile,
      allowSyntheticFixtures: true,
    });
    const removed = result.errors.find((p) => p.variable === 'FEATURE_MULTI_CHANNEL');
    expect(removed?.rule).toBe('contract/removed');
    expect(removed?.message).toContain('#411');
    expect(result.ok).toBe(false);
  });

  it('APROVAR_MENSAGENS_PROATIVAS points the operator at the real gate', () => {
    const result = validateConfig({
      env: envFor('production', { APROVAR_MENSAGENS_PROATIVAS: 'true' }),
      profile: 'production',
    });
    const problem = result.errors.find((p) => p.variable === 'APROVAR_MENSAGENS_PROATIVAS');
    expect(problem?.remediation).toContain('FEATURE_PROACTIVE_MESSAGES');
  });

  it.each(PROFILES)('an UNKNOWN Maia-namespaced variable is an error in %s', (profile) => {
    const result = validateConfig({
      env: envFor(profile, { MAIA_TOTALLY_MADE_UP: '1' }),
      profile,
      allowSyntheticFixtures: true,
    });
    const unknown = result.errors.find((p) => p.rule === 'contract/unknown');
    expect(unknown?.variable).toBe('MAIA_TOTALLY_MADE_UP');
    expect(unknown?.remediation).toContain('digitação');
    expect(result.ok).toBe(false);
  });

  it('third-party namespaces (CLAUDE_*, ANTHROPIC_*) are never rejected', () => {
    // A developer machine running Claude Code carries ~18 CLAUDE_* variables.
    // With the boot failing closed in every profile, claiming that namespace
    // would abort `npm run dev` and the whole suite on any such machine.
    const result = validateConfig({
      env: envFor('production', {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_PID: '1234',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      }),
      profile: 'production',
      allowSyntheticFixtures: true,
    });
    expect(result.errors.filter((p) => p.rule === 'contract/unknown')).toEqual([]);
  });

  it('OS / hosting variables outside Maia namespaces are never rejected', () => {
    const result = validateConfig({
      env: envFor('production', {
        PATH: '/usr/bin',
        HOME: '/root',
        PORT: '8080',
        RAILWAY_STATIC_URL: 'https://x.example',
      }),
      profile: 'production',
    });
    expect(result.errors.filter((p) => p.rule === 'contract/unknown')).toEqual([]);
  });

  it('a DEPRECATED variable produces an identifiable warning with its replacement', () => {
    const deprecated: EnvVarSpec = {
      name: 'MAIA_LEGACY_KNOB',
      description: 'Knob antigo mantido por um ciclo de release.',
      group: 'core',
      secret: false,
      services: ['runtime'],
      schema: z.string().optional(),
      deprecatedSince: '3.1.0',
      replacement: 'MAIA_NEW_KNOB',
      restartRequired: true,
    };
    const result = validateConfig({
      env: { MAIA_LEGACY_KNOB: 'x' },
      profile: 'development',
      entries: [deprecated],
      tombstones: [],
    });
    const warning = result.warnings.find((p) => p.rule === 'contract/deprecated');
    expect(warning?.message).toContain('3.1.0');
    expect(warning?.remediation).toContain('MAIA_NEW_KNOB');
    expect(result.ok).toBe(true);
  });
});

describe('validateConfig — secret redaction canary (#515)', () => {
  const CANARY = 'sk-ant-CANARY-b3c1d9e7f5a2-do-not-leak';

  function assertNoCanary(text: string, where: string) {
    expect(text.includes(CANARY), `canary leaked into ${where}`).toBe(false);
  }

  it('never echoes a secret value in human output, JSON output or a problem field', () => {
    // A secret that ALSO violates its schema: the Zod issue is the most likely
    // place for a value to leak.
    const env = envFor('production', {
      ANTHROPIC_API_KEY: CANARY,
      OPENROUTER_API_KEY: CANARY,
      POSTGRES_PASSWORD: CANARY,
      NEXTAUTH_SECRET: CANARY,
      SMTP_PASS: CANARY,
      TELEGRAM_BOT_TOKEN: CANARY,
      BACKUP_S3_SECRET_KEY: CANARY,
      RUNTIME_TRACE_HMAC_MASTER_SECRET: CANARY,
    });
    const result = validateConfig({ env, profile: 'production' });

    assertNoCanary(formatHuman(result), 'human output');
    assertNoCanary(formatJson(result), 'json output');
    for (const p of [...result.errors, ...result.warnings]) {
      assertNoCanary(p.message, `message of ${p.rule}`);
      assertNoCanary(p.remediation, `remediation of ${p.rule}`);
    }
    assertNoCanary(JSON.stringify(result.errors), 'serialised errors');
  });

  it('does not leak a secret through a schema violation message', () => {
    // OPENROUTER_API_KEY must start with `sk-or-`; the canary does not.
    const env = envFor('production', { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: CANARY });
    const result = validateConfig({ env, profile: 'production' });
    expect(result.ok).toBe(false);
    assertNoCanary(formatJson(result), 'json output of a schema violation');
  });
});
