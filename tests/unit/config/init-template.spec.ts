/**
 * Issue #515, PR #522 review round 1 [P1] — `maia config init` must not promote
 * a CI fixture to a production `.env`.
 *
 * The bug: for staging/production, `config init` wrote
 * `src/config/generated/fixtures/<profile>.env` verbatim. Those values exist so
 * CI can prove the contract is SATISFIABLE — `sk-ant-fixture-not-a-real-key`,
 * `fixture0000pass`, an all-zero base64 key block. They authenticate against
 * nothing, and they were not recognised as placeholders, so the very
 * `config check` the command printed reported success. A production
 * configuration that cannot work, certified valid.
 *
 * The contract fixed here, and pinned by these tests:
 *   1. `config init` emits an OPERATIONAL TEMPLATE, never a fixture;
 *   2. the template FAILS strict validation until the operator fills it in;
 *   3. filling it in makes it pass — so the template is complete, not just
 *      noisy;
 *   4. a fixture used as a real environment is REJECTED
 *      (`secret/synthetic-fixture`), so copying one by hand is caught too.
 */
import { describe, it, expect } from 'vitest';
import { buildFixture, renderEnvTemplate, renderFixture } from '@/config/generate.js';
import { parseEnvFile } from '@/config/env-file.js';
import { formatHuman, validateConfig } from '@/config/validate.js';
import { MAIA_PROFILES, type MaiaProfile, isOperatorPlaceholder } from '@/config/metadata.js';
import { CONTRACT_ENTRIES, isSyntheticFixtureValue } from '@/config/contract.js';

const STRICT: MaiaProfile[] = ['staging', 'production'];

/** Replace every operator placeholder with the synthetic value for that key. */
function fillTemplate(profile: MaiaProfile): Record<string, string> {
  const template = parseEnvFile(renderEnvTemplate(profile));
  const fixture = buildFixture(profile);
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(template)) {
    filled[key] = isOperatorPlaceholder(value) ? (fixture[key] ?? value) : value;
  }
  return filled;
}

describe('config init — o template não é uma fixture (#515 / PR #522 [P1])', () => {
  it.each(MAIA_PROFILES)('o template de %s não contém NENHUM valor de fixture', (profile) => {
    const template = parseEnvFile(renderEnvTemplate(profile));
    const leaked = Object.entries(template).filter(([k, v]) => isSyntheticFixtureValue(k, v));
    expect(
      leaked,
      'o template operacional nunca pode carregar um valor sintético de CI',
    ).toEqual([]);
  });

  it.each(MAIA_PROFILES)(
    'o template de %s difere da fixture do mesmo profile',
    (profile) => {
      expect(renderEnvTemplate(profile)).not.toBe(renderFixture(profile));
    },
  );

  it.each(STRICT)('o template de %s FALHA na validação estrita antes de ser preenchido', (profile) => {
    const env = parseEnvFile(renderEnvTemplate(profile));
    const result = validateConfig({ env, profile });
    expect(result.ok, 'um template não preenchido não pode passar por configuração válida').toBe(
      false,
    );
    // E falha exatamente por causa dos marcadores — não por acidente.
    expect(result.errors.some((p) => p.rule === 'secret/placeholder')).toBe(true);
  });

  it.each(STRICT)(
    'o template de %s PASSA depois de preenchido — ou seja, está completo',
    (profile) => {
      const result = validateConfig({
        env: fillTemplate(profile),
        profile,
        // Os valores de preenchimento vêm da fixture; só isso é dispensado.
        allowSyntheticFixtures: true,
      });
      expect(result.errors, formatHuman(result)).toEqual([]);
    },
  );

  it('o template de development também é utilizável depois de preenchido', () => {
    const result = validateConfig({
      env: fillTemplate('development'),
      profile: 'development',
      allowSyntheticFixtures: true,
    });
    expect(result.errors, formatHuman(result)).toEqual([]);
  });

  it('o template pede exatamente as chaves dos providers escolhidos, e não as outras', () => {
    const env = parseEnvFile(renderEnvTemplate('production'));
    // LLM_PROVIDER=openrouter e EMBEDDING_PROVIDER=voyage no template…
    expect(env.LLM_PROVIDER).toBe('openrouter');
    expect(env.EMBEDDING_PROVIDER).toBe('voyage');
    // …então a chave do OpenRouter e a da Voyage são pedidas…
    expect(env.OPENROUTER_API_KEY).toBeDefined();
    expect(env.VOYAGE_API_KEY).toBeDefined();
    // …e a da Cohere não, porque exigi-la bloquearia um `.env` legítimo.
    expect(env.COHERE_API_KEY).toBeUndefined();
  });

  it('o template puxa as dependências condicionais do profile (fecho de requiredWhen)', () => {
    const env = parseEnvFile(renderEnvTemplate('production'));
    // BACKUP_S3_BUCKET é requiredIn production; as credenciais vêm junto pelo
    // requiredWhen, senão o operador só descobriria no primeiro backup.
    expect(env.BACKUP_S3_BUCKET).toBeDefined();
    expect(env.BACKUP_S3_ACCESS_KEY).toBeDefined();
    expect(env.BACKUP_S3_SECRET_KEY).toBeDefined();
  });

  it('o template não ativa nada proibido no profile', () => {
    const env = parseEnvFile(renderEnvTemplate('production'));
    // ALLOW_DEV_AUTH / ADMIN_UI_DEV_LOGIN_TOKEN só existem em development.
    expect(env.ALLOW_DEV_AUTH).toBeUndefined();
    expect(env.ADMIN_UI_DEV_LOGIN_TOKEN).toBeUndefined();
  });

  it('as URLs externas do template já vêm em https fora de development', () => {
    const env = parseEnvFile(renderEnvTemplate('production'));
    for (const name of ['NEXTAUTH_URL', 'NEXT_PUBLIC_API_URL', 'OIDC_ISSUER']) {
      expect(env[name], name).toMatch(/^https:\/\//);
    }
  });

  it('MAIA_ENV e NODE_ENV são determinados pelo profile, não pedidos ao operador', () => {
    for (const profile of MAIA_PROFILES) {
      const env = parseEnvFile(renderEnvTemplate(profile));
      expect(env.MAIA_ENV).toBe(profile);
      expect(env.NODE_ENV).toBe(profile === 'development' ? 'development' : 'production');
    }
  });

  it('o cabeçalho do template diz que a validação falha de propósito', () => {
    const content = renderEnvTemplate('production');
    expect(content).toContain('__SET_ME__');
    expect(content).toContain('FALHA de propósito');
    expect(content).toContain('config:check');
  });
});

describe('secret/synthetic-fixture — rede de segurança (#515 / PR #522 [P1])', () => {
  it.each(STRICT)('uma fixture copiada para .env é recusada em %s', (profile) => {
    const result = validateConfig({ env: buildFixture(profile), profile });
    expect(result.ok).toBe(false);
    const problem = result.errors.find((p) => p.rule === 'secret/synthetic-fixture');
    expect(problem).toBeDefined();
    expect(problem!.remediation).toContain('config:init');
  });

  it('em development a fixture é aceita (é onde ela é usada de verdade)', () => {
    const result = validateConfig({ env: buildFixture('development'), profile: 'development' });
    expect(result.errors.filter((p) => p.rule === 'secret/synthetic-fixture')).toEqual([]);
  });

  it('--allow-placeholders NÃO silencia a detecção de fixture', () => {
    // Os dois flags são separados de propósito: `.env.example` roda com
    // --allow-placeholders e não deve, com isso, ganhar permissão para
    // carregar valores de fixture.
    const result = validateConfig({
      env: buildFixture('production'),
      profile: 'production',
      allowPlaceholders: true,
    });
    expect(result.errors.some((p) => p.rule === 'secret/synthetic-fixture')).toBe(true);
  });

  it('--allow-fixtures NÃO silencia a detecção de placeholder', () => {
    const result = validateConfig({
      env: { ...buildFixture('production'), NEXTAUTH_SECRET: '__SET_ME__ainda_nao_preenchido' },
      profile: 'production',
      allowSyntheticFixtures: true,
    });
    expect(result.errors.some((p) => p.rule === 'secret/placeholder')).toBe(true);
  });

  it('detecta o valor EXATO da fixture de cada segredo — um positivo por campo', () => {
    // Um positivo para cada segredo do contrato: se alguém copiar a fixture, a
    // proteção precisa continuar valendo em TODOS os campos, não só nos que
    // casavam com a regex antiga.
    const fixture = buildFixture('production');
    const secrets = CONTRACT_ENTRIES.filter((s) => s.secret && fixture[s.name] !== undefined);
    expect(secrets.length).toBeGreaterThan(10);
    for (const spec of secrets) {
      const value = fixture[spec.name]!;
      expect(isSyntheticFixtureValue(spec.name, value), `${spec.name}=${value}`).toBe(true);
    }
  });

  it('o mesmo valor em OUTRA variável não é fixture (a detecção é por chave)', () => {
    const fixture = buildFixture('production');
    const anthropic = fixture.ANTHROPIC_API_KEY!;
    expect(isSyntheticFixtureValue('ANTHROPIC_API_KEY', anthropic)).toBe(true);
    expect(isSyntheticFixtureValue('OPENAI_API_KEY', anthropic)).toBe(false);
  });

  it('valores legítimos que CONTÊM a palavra "fixture" não são recusados', () => {
    // Os três casos concretos da rodada 2 do review. A regex anterior reservava
    // globalmente uma palavra comum do inglês; com o boot fail-closed, cada um
    // destes derrubaria o processo em produção com uma mensagem falsa.
    const LEGIT: [string, string][] = [
      ['OWNER_NOME', 'Fixture Labs'],
      ['BACKUP_S3_BUCKET', 'maia-fixture-store'],
      ['NEXTAUTH_URL', 'https://fixture.example.com'],
    ];
    for (const [name, value] of LEGIT) {
      expect(isSyntheticFixtureValue(name, value), `${name}=${value}`).toBe(false);
      expect(isOperatorPlaceholder(value), `${name}=${value}`).toBe(false);
    }
  });

  it('os três valores legítimos passam na validação de production', () => {
    const result = validateConfig({
      env: {
        ...buildFixture('production'),
        OWNER_NOME: 'Fixture Labs',
        BACKUP_S3_BUCKET: 'maia-fixture-store',
        NEXTAUTH_URL: 'https://fixture.example.com',
      },
      profile: 'production',
      allowSyntheticFixtures: true,
    });
    expect(
      result.errors.filter((p) =>
        ['OWNER_NOME', 'BACKUP_S3_BUCKET', 'NEXTAUTH_URL'].includes(p.variable ?? ''),
      ),
      formatHuman(result),
    ).toEqual([]);
  });

  it('e não abortam o BOOT (o caminho que a regex ampla derrubaria)', async () => {
    // A prova que importa: com boot fail-closed, o falso positivo é uma queda
    // de produção, não um aviso.
    const { evaluateCrossFieldRules } = await import('@/config/rules.js');
    const raw = {
      ...buildFixture('production'),
      OWNER_NOME: 'Fixture Labs',
      BACKUP_S3_BUCKET: 'maia-fixture-store',
      NEXTAUTH_URL: 'https://fixture.example.com',
    };
    const findings = evaluateCrossFieldRules({ values: {}, raw, profile: 'production' });
    const falsePositives = findings.filter(
      (f) =>
        f.rule === 'secret/synthetic-fixture' &&
        ['OWNER_NOME', 'BACKUP_S3_BUCKET', 'NEXTAUTH_URL'].includes(f.variable ?? ''),
    );
    expect(falsePositives).toEqual([]);
  });

  it('variáveis não-secretas nunca entram na detecção', () => {
    // POSTGRES_USER=maia e TZ=America/Sao_Paulo SÃO os valores das fixtures, e
    // também exatamente o que um deployment real configura.
    const fixture = buildFixture('production');
    for (const name of ['POSTGRES_USER', 'POSTGRES_DB', 'TZ', 'EMBEDDING_MODEL', 'ALERT_CHANNELS']) {
      expect(isSyntheticFixtureValue(name, fixture[name]!), name).toBe(false);
    }
  });
});
