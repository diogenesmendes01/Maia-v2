/**
 * Issue #565 — o gate de migration fora do Compose.
 *
 * ESCOPO, dito na primeira linha porque é o ponto da issue: este arquivo
 * prova a SEMÂNTICA do gate — o comando que ele roda, o ambiente que ele
 * entrega, o exit code que ele propaga. Ele NÃO prova, e nada aqui deve
 * sugerir que prova, que um painel de deploy chama este comando no momento
 * certo e desiste do rollout quando ele sai != 0. Isso é
 * `docs/runbooks/deploy-prod.md` §7, marcado lá como NÃO VERIFICADO, e o
 * pedaço que um shell consegue demonstrar está em
 * `tests/integration/release-migrate-gate.spec.ts` (que roda o binário de
 * verdade contra um Postgres de verdade).
 *
 * As asserções sobre "o mesmo comando do job" leem `compose.prod.yml` do
 * disco. Nada abaixo constrói o YAML que depois confere.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { asMap, parseComposeFile, type ComposeNode } from './_compose-yaml.js';
import { CONTRACT_ENTRIES, entriesForService } from '@/config/contract.js';
import { loadServiceConfig } from '@/config/load.js';
import {
  MIGRATE_COMMAND,
  PROCESS_PASSTHROUGH,
  normalizeExitCode,
  runReleaseGate,
  scrubToMigratorSubset,
  type MigratorOutcome,
} from '@/migrations/release-gate.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const PROD = resolve(REPO_ROOT, 'compose.prod.yml');

/**
 * O ambiente que um painel com UM editor de variáveis por aplicação entrega
 * ao passo de migration: o `.env.app` inteiro, porque não existe "não passar"
 * ali. Valores sintéticos e inconfundíveis — nenhum deles pode reaparecer no
 * ambiente do filho nem em linha de log alguma.
 *
 * A forma `fixture-fixture-*` é deliberada e não é estilo: o gitleaks roda no
 * CI com as regras padrão, e a regra `generic-api-key` dispara em atribuições
 * cujo identificador contém `KEY`/`SECRET`/`PASSWORD` quando a entropia de
 * Shannon do valor passa de 3.5. Um valor "realista" aqui reprovaria o scanner,
 * e a saída certa é mudar a fixture — não afrouxar o scanner. Todos os valores
 * abaixo ficam sob 3.5.
 */
const COOLIFY_STYLE_ENV: Readonly<Record<string, string>> = Object.freeze({
  // — o que o migrator PODE ler (subset `migrator`, #515) —
  NODE_ENV: 'production',
  MAIA_ENV: 'production',
  DATABASE_URL: 'postgres://maia_prod:fixture-fixture-pass@postgres:5432/maia',
  POSTGRES_USER: 'maia_prod',
  POSTGRES_PASSWORD: 'fixture-fixture-pass',
  POSTGRES_DB: 'maia',
  TZ: 'America/Sao_Paulo',
  // — o que ele NÃO pode ler: segredos de app/admin-ui vindos do mesmo editor —
  ANTHROPIC_API_KEY: 'fixture-fixture-llm',
  OPENROUTER_API_KEY: 'fixture-fixture-llm',
  BACKUP_S3_SECRET_KEY: 'fixture-fixture-s3',
  BACKUP_S3_ACCESS_KEY: 'fixture-fixture-s3',
  NEXTAUTH_SECRET: 'fixture-fixture-auth',
  OIDC_CLIENT_SECRET: 'fixture-fixture-oidc',
  RUNTIME_TRACE_HMAC_MASTER_SECRET: 'fixture-fixture-trace',
  WHATSAPP_NUMBER_MAIA: '5511900000000',
  // — ruído de processo —
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/maia',
  npm_config_cache: '/tmp/.npm',
  npm_config_registry: 'https://registry.example.invalid/',
  NODE_OPTIONS: '--require /tmp/injected.js',
  COOLIFY_FIXTURE_LABEL: 'fixture-fixture',
});

/** Executa o gate com um `run` que só registra o que recebeu. */
async function gateWith(
  source: Readonly<Record<string, string | undefined>>,
  outcome: MigratorOutcome | (() => Promise<never>),
): Promise<{
  code: number;
  seen: { command: readonly string[]; env: Readonly<Record<string, string>> } | null;
  events: { event: string; detail: Record<string, unknown> }[];
}> {
  let seen: { command: readonly string[]; env: Readonly<Record<string, string>> } | null = null;
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const code = await runReleaseGate({
    source,
    emit: (event, detail) => events.push({ event, detail }),
    run: async (command, env) => {
      seen = { command, env };
      if (typeof outcome === 'function') return outcome();
      return outcome;
    },
  });
  return { code, seen, events };
}

describe('release gate — roda o MESMO job que o Compose (#565 sobre #516)', () => {
  it('o comando é byte a byte o `command:` do serviço `migrate` de compose.prod.yml', () => {
    const services = asMap(parseComposeFile(PROD).services, 'compose.prod.yml: services');
    const job = asMap(services.migrate, 'compose.prod.yml: services.migrate');
    const composeCommand = job.command as ComposeNode;
    expect(Array.isArray(composeCommand), 'services.migrate.command deve ser exec-form').toBe(true);
    expect([...MIGRATE_COMMAND]).toEqual(composeCommand as string[]);
  });

  it('o gate executa esse comando, e não outro', async () => {
    const { seen } = await gateWith(COOLIFY_STYLE_ENV, { kind: 'exit', code: 0 });
    expect(seen).not.toBeNull();
    expect([...(seen as unknown as { command: string[] }).command]).toEqual([...MIGRATE_COMMAND]);
  });
});

describe('release gate — o subset `migrator` do contrato (#515), por allowlist', () => {
  it('entrega ao migrator só o subset + a passthrough de processo', () => {
    const scrub = scrubToMigratorSubset(COOLIFY_STYLE_ENV);
    const allowed = new Set([
      ...entriesForService('migrator').map((s) => s.name),
      ...PROCESS_PASSTHROUGH,
    ]);
    const extra = Object.keys(scrub.env).filter((k) => !allowed.has(k));
    expect(extra, `variáveis fora da allowlist chegaram ao migrator: ${extra.join(', ')}`).toEqual([]);
  });

  it('retém TODA variável de contrato que não é do migrator, e a nomeia', () => {
    const scrub = scrubToMigratorSubset(COOLIFY_STYLE_ENV);
    const migratorNames = new Set(entriesForService('migrator').map((s) => s.name));
    const contractNames = new Set(CONTRACT_ENTRIES.map((s) => s.name));
    const shouldWithhold = Object.keys(COOLIFY_STYLE_ENV)
      .filter((k) => contractNames.has(k) && !migratorNames.has(k))
      .sort();
    // A fixture tem de exercitar o caso; uma lista vazia aqui tornaria a
    // asserção seguinte vácua.
    expect(shouldWithhold.length).toBeGreaterThan(0);
    expect([...scrub.withheldContract]).toEqual(shouldWithhold);
    for (const name of shouldWithhold) {
      expect(Object.keys(scrub.env), `${name} chegou ao migrator`).not.toContain(name);
    }
  });

  it('NOMEIA a MAIA_* desconhecida que reteve, em vez de engoli-la', () => {
    // Ela é retida como qualquer outra coisa fora do subset. Retê-la em
    // SILÊNCIO seria o problema: essa variável faria o migrator recusar o
    // boot (`contract/unknown`), então ou é um typo numa configuração que o
    // operador acha ativa, ou algo que ninguém declarou. O deploy fica verde;
    // a linha de log é o que resta para o operador descobrir.
    const scrub = scrubToMigratorSubset({
      ...COOLIFY_STYLE_ENV,
      MAIA_LEFTOVER_FROM_APP_ENV: 'fixture',
    });
    expect([...scrub.withheldUnknownMaia]).toEqual(['MAIA_LEFTOVER_FROM_APP_ENV']);
    expect(Object.keys(scrub.env)).not.toContain('MAIA_LEFTOVER_FROM_APP_ENV');
    // E não é contada duas vezes.
    expect([...scrub.withheldContract]).not.toContain('MAIA_LEFTOVER_FROM_APP_ENV');
  });

  it('retém NODE_OPTIONS e as npm_config_* que não são o cache', () => {
    const scrub = scrubToMigratorSubset(COOLIFY_STYLE_ENV);
    expect(Object.keys(scrub.env)).not.toContain('NODE_OPTIONS');
    expect(Object.keys(scrub.env)).not.toContain('npm_config_registry');
    expect(Object.keys(scrub.env)).toContain('npm_config_cache');
  });

  it('preserva o que o processo precisa para existir (PATH/HOME)', () => {
    const scrub = scrubToMigratorSubset(COOLIFY_STYLE_ENV);
    expect(scrub.env.PATH).toBe(COOLIFY_STYLE_ENV.PATH);
    expect(scrub.env.HOME).toBe(COOLIFY_STYLE_ENV.HOME);
  });

  it('o ambiente filtrado ainda SATISFAZ o contrato do migrator', () => {
    // A metade executável da afirmação: filtrar demais quebraria o job na
    // primeira linha (`loadMigrationConfig()` em scripts/migrate.ts).
    const scrub = scrubToMigratorSubset(COOLIFY_STYLE_ENV);
    expect(() => loadServiceConfig('migrator', { env: scrub.env })).not.toThrow();
  });

  it('uma variável ausente não vira string vazia no filho', () => {
    const scrub = scrubToMigratorSubset({ ...COOLIFY_STYLE_ENV, LOG_LEVEL: undefined });
    expect(Object.keys(scrub.env)).not.toContain('LOG_LEVEL');
  });

  it('nenhum valor retido aparece no relatório do gate', async () => {
    const { events } = await gateWith(COOLIFY_STYLE_ENV, { kind: 'exit', code: 0 });
    const serialized = JSON.stringify(events);
    const migratorNames = new Set(entriesForService('migrator').map((s) => s.name));
    for (const [name, value] of Object.entries(COOLIFY_STYLE_ENV)) {
      if (migratorNames.has(name)) continue;
      expect(serialized, `o valor de ${name} vazou para o log do gate`).not.toContain(value);
    }
    const scrubbed = events.find((e) => e.event === 'release_gate.env_scrubbed');
    expect(scrubbed?.detail.withheld_contract).toContain('ANTHROPIC_API_KEY');
  });
});

describe('release gate — exit code: 0 sai por um caminho só', () => {
  it('propaga 0 quando o migrator sai 0', async () => {
    const { code, events } = await gateWith(COOLIFY_STYLE_ENV, { kind: 'exit', code: 0 });
    expect(code).toBe(0);
    expect(events.map((e) => e.event)).toContain('release_gate.passed');
  });

  it.each([1, 2, 137])('propaga %i sem alterar', async (childCode) => {
    const { code } = await gateWith(COOLIFY_STYLE_ENV, { kind: 'exit', code: childCode });
    expect(code).toBe(childCode);
  });

  it('bloqueia quando o migrator morre por sinal', async () => {
    const { code, events } = await gateWith(COOLIFY_STYLE_ENV, { kind: 'signal', signal: 'SIGKILL' });
    expect(code).not.toBe(0);
    expect(events.at(-1)?.detail.reason).toBe('killed_by_signal');
  });

  it('bloqueia quando o processo nem chega a nascer', async () => {
    const { code, events } = await gateWith(COOLIFY_STYLE_ENV, () => Promise.reject(new Error('ENOENT')));
    expect(code).toBe(1);
    expect(events.at(-1)?.detail.reason).toBe('spawn_failed');
  });

  it('normalizeExitCode nunca inventa um sucesso', () => {
    expect(normalizeExitCode(0)).toBe(0);
    for (const weird of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeExitCode(weird), `código ${weird} virou sucesso`).not.toBe(0);
    }
    expect(normalizeExitCode(2)).toBe(2);
  });
});
