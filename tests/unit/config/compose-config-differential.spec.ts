/**
 * DIFERENCIAL: o ambiente que `src/config/compose-env.ts` reconstrói é
 * comparado com o que o `docker compose config` REAL resolve (review de PR
 * #595, achado [Média]).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que sem este arquivo o verde era autoconsistente
 * ─────────────────────────────────────────────────────────────────────────
 * Todo o resto da suíte passa pelo MESMO parser customizado que o preflight
 * usa. Se ele entender `${VAR}` num `env_file` de um jeito e o Compose de
 * outro, os dois lados do teste erram juntos e ninguém fica vermelho. A única
 * medição independente é perguntar ao Compose.
 *
 * `docker compose config` NÃO precisa de daemon: ele só carrega, interpola e
 * imprime o modelo do projeto. Por isso este caso roda numa spec de unidade e
 * não em `tests/integration` — não há Postgres, Redis nem imagem envolvidos.
 *
 * SEM VALOR DE PRODUÇÃO NA SAÍDA: o projeto comparado é sintético e montado no
 * `tmpdir`. Nenhum `.env.*` do repositório entra aqui, e nada que o
 * `docker compose config` imprima é segredo.
 *
 * QUANDO NÃO HÁ `docker compose` NA MÁQUINA o arquivo é PULADO, com o motivo no
 * nome do `describe` — pulado não é passou, e o resumo da suíte conta os dois
 * separadamente. No CI a variável `MAIA_REQUIRE_COMPOSE_DIFFERENTIAL=1` (job
 * `validate` em `.github/workflows/ci.yml`) transforma a ausência em FALHA, para
 * que o diferencial não deixe de rodar em silêncio justamente onde ele importa.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveServiceEnv, parseComposeText } from '@/config/compose-env.js';

function composeCliDisponivel(): boolean {
  const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  return r.status === 0;
}

const DISPONIVEL = composeCliDisponivel();

if (!DISPONIVEL && process.env.MAIA_REQUIRE_COMPOSE_DIFFERENTIAL === '1') {
  throw new Error(
    'MAIA_REQUIRE_COMPOSE_DIFFERENTIAL=1 mas `docker compose version` falhou. ' +
      'Este ambiente deveria ter o CLI do Compose — sem ele o diferencial não mede nada.',
  );
}

/**
 * O projeto sintético. Cada linha existe para uma forma que o parser precisa
 * acertar; um caso a menos aqui é uma forma que volta a divergir em silêncio.
 */
const COMPOSE = [
  'services:',
  '  app:',
  '    image: busybox',
  '    env_file:',
  '      - .env.a',
  '      - .env.b',
  '    environment:',
  '      MAIA_ENV: ${MAIA_ENV:?obrigatória}',
  '      DATABASE_URL: postgres://${PGUSER:?}:${PGPASS:?}@db:5432/${PGDB:-maia}',
  '      DE_CIMA: do-compose',
  '      LITERAL_CIFRAO: pa$$word',
  '',
].join('\n');

const INFRA = [
  'MAIA_ENV=production',
  'PGUSER=maia_prod',
  'PGPASS=f4kepass',
  'DOMAIN=example.com',
  'EMPTYV=',
  'SHADOW=do-projeto',
  '',
].join('\n');

const ENV_A = [
  'PLAIN=$DOMAIN',
  'BRACED=${DOMAIN}',
  'DEF_EMPTY=${EMPTYV:-fallback}',
  'DEF_EMPTY_SEM_COLON=${EMPTYV-fallback}',
  'DEF_MISS=${NOPE-fallback}',
  'PLUS=${DOMAIN:+sim}',
  'PLUS_EMPTY=${EMPTYV:+sim}',
  'PLUS_EMPTY_SEM_COLON=${EMPTYV+sim}',
  'CIFRAO=pa$$word',
  'SHADOW=do-arquivo',
  'USA_SHADOW=${SHADOW}',
  'PRIMEIRA=um',
  'USA_PRIMEIRA=${PRIMEIRA}/x',
  "ASPAS_SIMPLES='literal ${DOMAIN} x'",
  'ASPAS_DUPLAS="dupla ${DOMAIN}"',
  'DE_CIMA=do-a',
  'SO_NO_A=a',
  '',
].join('\n');

const ENV_B = ['DE_CIMA=do-b', 'DEPOIS=${PRIMEIRA}/y', ''].join('\n');

/**
 * `docker compose config` reescreve `$` como `$$` na SAÍDA (é a forma de
 * escapar num arquivo Compose). Desfazer isso é o que torna os dois lados
 * comparáveis — e não fazê-lo daria um vermelho falso em toda senha com `$`.
 */
function desescapar(value: string): string {
  return value.replace(/\$\$/g, '$');
}

interface ComposeConfigJson {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

function ambienteDoCompose(
  dir: string,
  extraShell: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const r = spawnSync(
    'docker',
    ['compose', '--env-file', '.env.infra', '-f', 'compose.yml', 'config', '--format', 'json'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, ...extraShell } },
  );
  expect(r.status, `docker compose config falhou:\n${r.stderr}`).toBe(0);
  const parsed = JSON.parse(r.stdout) as ComposeConfigJson;
  const env = parsed.services.app?.environment ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== null) out[k] = desescapar(v);
  }
  return out;
}

function nossoAmbiente(infraText = INFRA): Record<string, string> {
  return effectiveServiceEnv(parseComposeText(COMPOSE, 'compose.yml'), 'app', {
    envFileContents: [ENV_A, ENV_B],
    envFileNames: ['.env.a', '.env.b'],
    infra: Object.fromEntries(
      infraText
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    ),
  });
}

function projeto(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maia-compose-diff-'));
  writeFileSync(join(dir, 'compose.yml'), COMPOSE);
  writeFileSync(join(dir, '.env.infra'), INFRA);
  writeFileSync(join(dir, '.env.a'), ENV_A);
  writeFileSync(join(dir, '.env.b'), ENV_B);
  return dir;
}

describe.skipIf(!DISPONIVEL)(
  'diferencial contra o `docker compose config` real (issue #572, review de PR #595)',
  () => {
    it('o ambiente efetivo do serviço é IDÊNTICO ao que o Compose resolve', () => {
      const dir = projeto();
      try {
        expect(nossoAmbiente()).toEqual(ambienteDoCompose(dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it('o Compose realmente dá precedência ao SHELL sobre o `--env-file`', () => {
      // Esta é a premissa da checagem de divergência do preflight. Se ela for
      // falsa, aquela checagem é ruído — e é o `docker compose` quem responde.
      const dir = projeto();
      try {
        const comShell = ambienteDoCompose(dir, { MAIA_ENV: 'staging' });
        expect(comShell.MAIA_ENV).toBe('staging');
        // …e o nosso, hermético, continua no valor do arquivo. A diferença é
        // exatamente o que `runPreflight` reprova via `shellDivergence`.
        expect(nossoAmbiente().MAIA_ENV).toBe('production');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    it('um `${VAR:?}` sem valor aborta o Compose — e o nosso lado LANÇA no mesmo ponto', () => {
      const dir = projeto();
      try {
        writeFileSync(join(dir, '.env.infra'), INFRA.replace('MAIA_ENV=production\n', ''));
        const r = spawnSync(
          'docker',
          ['compose', '--env-file', '.env.infra', '-f', 'compose.yml', 'config'],
          { cwd: dir, encoding: 'utf8', env: { ...process.env, MAIA_ENV: '' } },
        );
        expect(r.status).not.toBe(0);
        expect(() => nossoAmbiente(INFRA.replace('MAIA_ENV=production\n', ''))).toThrow(
          /MAIA_ENV is required/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
