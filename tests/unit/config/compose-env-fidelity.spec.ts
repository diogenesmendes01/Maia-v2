/**
 * O ambiente reconstruído pelo preflight é o ambiente do Compose — e o erro de
 * parse nunca carrega o valor (review de PR #595, achados [Alta] nº 2 e [Média]).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que estes casos existem
 * ─────────────────────────────────────────────────────────────────────────
 * O preflight só vale alguma coisa se o ambiente que ele certifica for o mesmo
 * que o `docker compose up` monta. Duas infidelidades estavam abertas:
 *
 *   1. A interpolação entendia TRÊS formas e deixava o resto passar verbatim.
 *      `$$`, `$VAR` e `${VAR:+x}` são sintaxe legítima do Compose, e um compose
 *      que as usasse produzia aqui um ambiente diferente — com o preflight
 *      verde.
 *   2. `env_file` era lido com `dotenv.parse` e mais nada. O `docker compose`
 *      INTERPOLA dentro de um `env_file` (`compose-go/dotenv.ParseWithLookup`,
 *      via `GetEnvFromFile`) e respeita aspas simples como literal.
 *
 * A comparação com o `docker compose config` real vive em
 * `tests/integration/compose-config-differential.spec.ts` — este arquivo é a
 * unidade, pura e sem daemon.
 *
 * E o canário de vazamento: um `--compose` com segredo numa linha malformada
 * NÃO pode aparecer em stdout, stderr nem na saída JSON. O valor do canário é
 * MONTADO em código (baixa entropia, repetitivo) de propósito: um literal
 * parecido com segredo faria o gitleaks reprovar o próprio teste.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ComposeParseError,
  asMap,
  asString,
  effectiveServiceEnv,
  interpolate,
  interpolationRefs,
  parseComposeEnvFile,
  parseComposeText,
} from '@/config/compose-env.js';
import { runPreflight } from '@/config/preflight.js';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Marcador de vazamento. Montado, repetitivo e sem entropia — não é segredo. */
const CANARIO = ['CANARIO', 'VAZAMENTO', 'a'.repeat(16)].join('-');

describe('interpolação — todas as formas do compose-go/template', () => {
  const env = { SET: 'v', EMPTY: '' };

  it('resolve as formas simples', () => {
    expect(interpolate('$SET/${SET}', env)).toBe('v/v');
    expect(interpolate('${MISSING}', env)).toBe('');
    expect(interpolate('${EMPTY}', env)).toBe('');
  });

  it('`$$` é um `$` literal — e não o começo de uma expressão', () => {
    // Sem isto, `$${NOT_A_VAR}` virava a expansão de NOT_A_VAR: um valor
    // literal do compose (uma senha com `$`, um crontab) mudava de sentido.
    expect(interpolate('$$', env)).toBe('$');
    expect(interpolate('$${SET}', env)).toBe('${SET}');
    expect(interpolate('pa$$word', env)).toBe('pa$word');
  });

  it('distingue `:-`/`-` e `:+`/`+` por "vazio conta como ausente"', () => {
    expect(interpolate('${EMPTY:-d}', env)).toBe('d');
    expect(interpolate('${EMPTY-d}', env)).toBe('');
    expect(interpolate('${MISSING-d}', env)).toBe('d');
    expect(interpolate('${SET:+r}', env)).toBe('r');
    expect(interpolate('${EMPTY:+r}', env)).toBe('');
    expect(interpolate('${EMPTY+r}', env)).toBe('r');
    expect(interpolate('${MISSING+r}', env)).toBe('');
  });

  it('`:?` e `?` são fail-closed, como no `docker compose up`', () => {
    expect(() => interpolate('${EMPTY:?obrigatória}', env)).toThrow(/EMPTY is required/);
    expect(() => interpolate('${MISSING?obrigatória}', env)).toThrow(/MISSING is required/);
    expect(interpolate('${EMPTY?ok}', env)).toBe('');
  });

  it('aninha: o default é ele próprio interpolado', () => {
    expect(interpolate('${MISSING:-${SET}}', env)).toBe('v');
    expect(interpolate('${MISSING:-${ALSO_MISSING:-fim}}', env)).toBe('fim');
  });

  it('LANÇA no que não souber, em vez de resolver diferente do Compose', () => {
    expect(() => interpolate('100% de $ ', env)).toThrow(/lone `\$`/);
    expect(() => interpolate('${SET', env)).toThrow(/unterminated/);
    expect(() => interpolate('${}', env)).toThrow(/without a variable name/);
    expect(() => interpolate('${SET*x}', env)).toThrow(/unsupported operator/);
  });

  it('a mensagem de erro carrega o CAMINHO, nunca o valor', () => {
    try {
      interpolate(`${CANARIO}$`, {}, 'services.app.environment.SECRET');
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('services.app.environment.SECRET');
      expect(msg).not.toContain(CANARIO);
    }
  });

  it('interpolationRefs enxerga toda variável referenciada, inclusive nos defaults', () => {
    expect([...interpolationRefs('$A ${B} ${C:-${D}} $$E')].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('env_file — a semântica do Compose, não a do dotenv/config', () => {
  const project = { DOMAIN: 'example.com', SHADOW: 'do-projeto' };

  it('interpola `${VAR}` dentro do arquivo — o `docker compose` interpola', () => {
    const out = parseComposeEnvFile('NEXTAUTH_URL=https://${DOMAIN}/admin\n', '.env.admin', {
      project,
    });
    expect(out.NEXTAUTH_URL).toBe('https://example.com/admin');
  });

  it('ASPAS SIMPLES são literais — nem o Compose expande dentro delas', () => {
    const out = parseComposeEnvFile("LITERAL='https://${DOMAIN}/x'\n", '.env.admin', { project });
    expect(out.LITERAL).toBe('https://${DOMAIN}/x');
  });

  it('ASPAS DUPLAS expandem, e os escapes do dotenv continuam valendo', () => {
    const out = parseComposeEnvFile('DUPLA="https://${DOMAIN}/x"\nQUEBRA="a\\nb"\n', '.env.app', {
      project,
    });
    expect(out.DUPLA).toBe('https://example.com/x');
    expect(out.QUEBRA).toBe('a\nb');
  });

  it('uma chave do arquivo resolve outra do MESMO arquivo, na ordem', () => {
    const out = parseComposeEnvFile('HOST=db.internal\nURL=postgres://${HOST}/maia\n', '.env.app', {
      project: {},
    });
    expect(out.URL).toBe('postgres://db.internal/maia');
  });

  it('o ambiente do PROJETO vence a chave homônima do arquivo, como no compose-go', () => {
    const out = parseComposeEnvFile('SHADOW=do-arquivo\nUSA=${SHADOW}\n', '.env.app', { project });
    // O valor GRAVADO é o do arquivo…
    expect(out.SHADOW).toBe('do-arquivo');
    // …mas a RESOLUÇÃO de `${SHADOW}` usa o projeto (currentEnv > envMap).
    expect(out.USA).toBe('do-projeto');
  });

  it('`$$` num env_file é um `$` literal', () => {
    const out = parseComposeEnvFile('SENHA=pa$$word\n', '.env.app', { project: {} });
    expect(out.SENHA).toBe('pa$word');
  });
});

describe('effectiveServiceEnv — precedência e composição', () => {
  const COMPOSE = [
    'services:',
    '  app:',
    '    env_file:',
    '      - .env.a',
    '      - .env.b',
    '    environment:',
    '      MAIA_ENV: ${MAIA_ENV:?obrigatória}',
    '      DE_CIMA: do-compose',
    '',
  ].join('\n');

  it('`environment:` vence `env_file`, e o último `env_file` vence o primeiro', () => {
    const env = effectiveServiceEnv(parseComposeText(COMPOSE, 'c.yml'), 'app', {
      envFileContents: ['DE_CIMA=do-a\nSO_NO_A=a\n', 'DE_CIMA=do-b\n'],
      envFileNames: ['.env.a', '.env.b'],
      infra: { MAIA_ENV: 'production' },
    });
    expect(env).toEqual({ SO_NO_A: 'a', DE_CIMA: 'do-compose', MAIA_ENV: 'production' });
  });

  it('um `env_file` posterior enxerga as chaves do anterior na interpolação', () => {
    const env = effectiveServiceEnv(parseComposeText(COMPOSE, 'c.yml'), 'app', {
      envFileContents: ['HOST=db.internal\n', 'URL=postgres://${HOST}/maia\n'],
      envFileNames: ['.env.a', '.env.b'],
      infra: { MAIA_ENV: 'production' },
    });
    expect(env.URL).toBe('postgres://db.internal/maia');
  });
});

describe('CANÁRIO de vazamento — o erro de parse não carrega o valor', () => {
  it('ComposeParseError diz arquivo, linha e motivo — e só', () => {
    const composeText = ['services:', '  app:', `\tSECRET: ${CANARIO}`, ''].join('\n');
    try {
      parseComposeText(composeText, 'compose.suspeito.yml');
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(ComposeParseError);
      const msg = (err as Error).message;
      expect(msg).toContain('compose.suspeito.yml:3');
      expect(msg).toContain('tab in indentation');
      expect(msg).not.toContain(CANARIO);
    }
  });

  it('uma linha que o parser não entende também não ecoa o valor', () => {
    const composeText = ['services:', '  app:', `    ${CANARIO} sem dois-pontos`, ''].join('\n');
    expect(() => parseComposeText(composeText, 'c.yml')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(CANARIO) }) as Error,
    );
  });

  it('os helpers de shape descrevem o TIPO do nó, não o conteúdo', () => {
    const node = parseComposeText(
      ['services:', '  app:', '    environment:', `      - DATABASE_URL=${CANARIO}`, ''].join('\n'),
      'c.yml',
    );
    const app = asMap(asMap(node.services, 'services').app, 'services.app');
    expect(() => asMap(app.environment, 'services.app.environment')).toThrow(
      /expected services\.app\.environment to be a map, got a sequence of 1 item\(s\)/,
    );
    expect(() => asString(app.environment, 'services.app.environment')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(CANARIO) }) as Error,
    );
  });

  it('o `failure` que o preflight publica por serviço também não ecoa o valor', () => {
    const composeText = [
      'services:',
      '  app:',
      '    env_file:',
      '      - .env.app',
      '    environment:',
      `      - DATABASE_URL=${CANARIO}`,
      '',
    ].join('\n');
    const report = runPreflight({
      composeText,
      composeLabel: 'c.yml',
      infraText: '',
      readEnvFile: () => '',
    });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(CANARIO);
  });
});

describe('CANÁRIO de vazamento — a CLI, em stdout, stderr e --json', () => {
  const require_ = createRequire(join(REPO_ROOT, 'package.json'));
  // `tsx/cli` é o subpath EXPORTADO (o caminho físico `tsx/dist/cli.mjs` não é).
  const TSX = require_.resolve('tsx/cli');

  function rodarPreflight(
    composeText: string,
    json: boolean,
    opts: {
      readonly infra?: string;
      readonly envApp?: string;
      readonly shell?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'maia-preflight-'));
    try {
      writeFileSync(join(dir, 'compose.yml'), composeText);
      writeFileSync(join(dir, '.env.infra'), opts.infra ?? 'MAIA_ENV=production\n');
      writeFileSync(join(dir, '.env.app'), opts.envApp ?? 'ALERT_CHANNELS=log\n');
      const args = [
        TSX,
        'scripts/config.ts',
        'preflight',
        '--compose',
        join(dir, 'compose.yml'),
        '--infra',
        join(dir, '.env.infra'),
      ];
      if (json) args.push('--json');
      const r = spawnSync(process.execPath, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', ...opts.shell },
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Compose com o segredo numa linha que o parser recusa. */
  const MALFORMADO = ['services:', '  app:', `\tDATABASE_URL: ${CANARIO}`, ''].join('\n');

  /** Compose que parseia, mas cujo `environment:` tem shape inesperado. */
  const SHAPE_INESPERADO = [
    'services:',
    '  app:',
    '    env_file:',
    '      - .env.app',
    '    environment:',
    `      - DATABASE_URL=${CANARIO}`,
    '',
  ].join('\n');

  it.each([
    ['linha malformada', MALFORMADO],
    ['shape inesperado', SHAPE_INESPERADO],
  ])('%s: nada do valor sai em stdout nem em stderr', (_nome, composeText) => {
    expect(composeText).toContain(CANARIO); // a entrada tem o canário, senão o caso não mede nada
    const r = rodarPreflight(composeText, false);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(CANARIO);
    expect(r.stderr).not.toContain(CANARIO);
  }, 60_000);

  it.each([
    ['linha malformada', MALFORMADO],
    ['shape inesperado', SHAPE_INESPERADO],
  ])('%s: nada do valor sai na saída --json', (_nome, composeText) => {
    const r = rodarPreflight(composeText, true);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(CANARIO);
    expect(r.stderr).not.toContain(CANARIO);
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // Divergência de shell numa variável que só existe DENTRO do `env_file`
  // ─────────────────────────────────────────────────────────────────────────
  // A checagem passou a ler os `env_file` para colher NOMES de referência
  // (review de PR #595, rodada 2). Ler arquivo é justamente o passo em que um
  // valor pode escorregar para a mensagem — e o achado anterior desta mesma PR
  // foi exatamente isso, do outro lado. Aqui os DOIS valores em jogo são
  // canários: o do `.env.infra` e o que o shell tenta impor.

  /** Valores montados, repetitivos e sem entropia — não são segredo. */
  const CANARIO_ARQUIVO = ['canario', 'arquivo', 'a'.repeat(12)].join('-');
  const CANARIO_SHELL = ['canario', 'shell', 's'.repeat(12)].join('-');

  /** `CANARIO_HOST` é referenciado SÓ dentro do `.env.app`, nunca no YAML. */
  const SO_NO_ENV_FILE = [
    'services:',
    '  app:',
    '    image: busybox',
    '    env_file:',
    '      - .env.app',
    '    environment:',
    '      MAIA_ENV: ${MAIA_ENV:?obrigatória}',
    '',
  ].join('\n');

  const INFRA_COM_CANARIO = `MAIA_ENV=production\nCANARIO_HOST=${CANARIO_ARQUIVO}\n`;
  const ENV_APP_COM_CANARIO = 'ALERT_CHANNELS=log\nURL_DO_CANARIO=https://${CANARIO_HOST}/x\n';

  it.each([
    ['humana', false],
    ['--json', true],
  ])(
    'saída %s: a divergência nomeia CANARIO_HOST e não vaza NENHUM dos dois valores',
    (_nome, json) => {
      expect(SO_NO_ENV_FILE).not.toContain('CANARIO_HOST'); // a premissa, escrita
      const r = rodarPreflight(SO_NO_ENV_FILE, json, {
        infra: INFRA_COM_CANARIO,
        envApp: ENV_APP_COM_CANARIO,
        shell: { CANARIO_HOST: CANARIO_SHELL },
      });
      expect(r.status).toBe(1);
      // Não vacuidade: se a divergência não fosse detectada, as três negativas
      // abaixo passariam sozinhas e o canário não mediria nada.
      expect(r.stdout).toContain('CANARIO_HOST');
      for (const saida of [r.stdout, r.stderr]) {
        expect(saida).not.toContain(CANARIO_SHELL);
        expect(saida).not.toContain(CANARIO_ARQUIVO);
      }
    },
    60_000,
  );
});
