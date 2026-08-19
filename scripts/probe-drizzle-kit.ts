/**
 * Sonda descartável do `drizzle-kit` — issue #574, achado da revisão do PR #594.
 *
 * Por que ela existe
 * ------------------
 * A #574 troca o MAJOR do `drizzle-kit` (0.28 → 0.31) para zerar o
 * `GHSA-67mh-4wv8-2f99`. Antes desta sonda, NADA versionado exercitava o
 * binário que a issue troca:
 *
 *   - não havia `drizzle.config.ts`, script npm nem passo de CI invocando `drizzle-kit`;
 *   - `tests/unit/drizzle-kit-esbuild-advisory.spec.ts` afere LOCKFILE, e diz
 *     isso de si mesmo;
 *   - o smoke de migrations roda `tsx scripts/migrate.ts` sobre os `.sql` já
 *     versionados — ele nunca carrega o loader/gerador do drizzle-kit.
 *
 * Ou seja: uma regressão do gerador neste major, ou num update futuro que o
 * Dependabot abra dentro de `^0.31`, passaria por todos os checks. Para uma
 * ferramenta de schema, é exatamente o risco que motivou a #574.
 *
 * O que ela prova, de fato
 * ------------------------
 *  1. o CLI CARREGA o schema real — inclusive os aliases `@/*` do
 *     `tsconfig.json`. `src/db/schema.ts` importa `AUDIENCE_TYPES` /
 *     `TRUST_LEVELS` de `@/shared/audience.js`, e o `drizzle-kit` 0.28 morria
 *     aqui com `Cannot find module '@/shared/audience.js'`. A sonda não se
 *     contenta com "o processo saiu 0": ela exige que os literais que só
 *     existem DEPOIS do alias resolvido apareçam no SQL gerado;
 *  2. o SQL gerado é APLICÁVEL num Postgres de verdade (`up`);
 *  3. o gerador fecha o round-trip: a partir do snapshot que ele mesmo gravou,
 *     `generate` contra um schema VAZIO produz o `down` (os `DROP TABLE`), que
 *     também aplica e devolve o banco ao zero.
 *
 * Nada disso reusa o runner de migrations do repo: o objeto sob teste é o
 * binário do `drizzle-kit`, não o `scripts/migrate.ts`.
 *
 * Descartável de verdade
 * ----------------------
 * O `up`/`down` roda num banco CRIADO e DERRUBADO por esta execução
 * (`drizzle_kit_probe_<ts>_<rand>`). A sonda nunca toca no banco apontado por
 * `DATABASE_URL` — ela só usa aquela URL para saber HOST/USER/SENHA e conecta
 * no banco de manutenção `postgres` para o `CREATE`/`DROP DATABASE`. O SQL
 * gerado e o snapshot vão para `node_modules/.cache/` (gitignorado) e somem no
 * fim.
 *
 * Por que a saída fica em caminho RELATIVO: o `drizzle-kit` 0.31 relê o
 * snapshot anterior como `./${out}`. Com `--out` absoluto isso vira `.//tmp/...`
 * e a segunda invocação (o `down`) morre em ENOENT. Caminho relativo à raiz do
 * repo é a única forma que funciona nas DUAS invocações.
 *
 * Por que NÃO existe `drizzle.config.ts`: tudo o que a sonda precisa vai por
 * flag (`--dialect`, `--schema`, `--out`). Versionar um config mudaria o
 * comportamento default de qualquer `drizzle-kit` que alguém rodasse à mão na
 * raiz, e a #574 não pediu isso.
 *
 * Uso: `npm run probe:drizzle-kit` (a partir da raiz do repo, com Postgres de
 * pé). Roda no job `drizzle-kit-roundtrip` do CI, bloqueante.
 *
 * Exit: 0 round-trip fechado · 1 qualquer etapa reprovada.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { AUDIENCE_TYPES, TRUST_LEVELS } from '@/shared/audience.js';

const ROOT = process.cwd();

/** Schema real. Aponta de propósito para o arquivo de produção, não para uma fixture. */
const SCHEMA = 'src/db/schema.ts';

/**
 * Tabela cujo DDL só existe se o alias `@/shared/audience.js` tiver resolvido:
 * os dois CHECKs abaixo são gerados a partir das constantes importadas de lá.
 */
const TABELA_DO_ALIAS = 'agent_audience_profiles';

/** Piso grosseiro de sanidade: o schema real tem ~97 tabelas. */
const MINIMO_DE_TABELAS = 50;

/** Teto de tempo por invocação do CLI. Gerar o schema inteiro leva ~10s aqui. */
const TIMEOUT_CLI_MS = 180_000;

function log(evento: string, detalhe: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ evento, ...detalhe }));
}

class ProbeError extends Error {}

function exigir(condicao: unknown, mensagem: string): asserts condicao {
  if (!condicao) throw new ProbeError(mensagem);
}

/**
 * O `bin.cjs` do `drizzle-kit` INSTALADO nesta árvore — nunca um `npx` que
 * baixa outro. A busca sobe os `node_modules/` como o próprio Node faria, em
 * vez de `require.resolve('drizzle-kit/package.json')`: o pacote tem `exports`
 * e não publica `./package.json`, então a resolução por subpath quebra.
 */
function resolverBinarioLocal(): { bin: string; versao: string } {
  let pkgPath = '';
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const candidato = join(dir, 'node_modules', 'drizzle-kit', 'package.json');
    if (existsSync(candidato)) {
      pkgPath = candidato;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!pkgPath) {
    throw new ProbeError('drizzle-kit não está instalado nesta árvore — rode `npm ci` antes da sonda');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    version?: string;
    bin?: Record<string, string> | string;
  };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['drizzle-kit'];
  exigir(typeof rel === 'string', 'drizzle-kit não declara bin — instalação corrompida');
  const bin = join(dirname(pkgPath), rel);
  exigir(existsSync(bin), `bin do drizzle-kit não existe no disco: ${bin}`);
  return { bin, versao: pkg.version ?? '(desconhecida)' };
}

/**
 * Roda `drizzle-kit generate`. `cwd` é a RAIZ do repo de propósito: é de lá que
 * o CLI acha o `tsconfig.json` cujos `paths` resolvem `@/*`. Rodando de
 * qualquer outro diretório o schema real não carrega — foi assim que se mediu.
 */
function gerar(bin: string, schema: string, out: string, nome: string): void {
  const r = spawnSync(
    process.execPath,
    [bin, 'generate', '--dialect=postgresql', `--schema=${schema}`, `--out=${out}`, `--name=${nome}`],
    { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_CLI_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) throw new ProbeError(`drizzle-kit generate (${nome}) não executou: ${r.error.message}`);
  if (r.status !== 0) {
    throw new ProbeError(`drizzle-kit generate (${nome}) saiu ${String(r.status)}:\n${saida.slice(-2000)}`);
  }
  // O CLI 0.28 imprime o MODULE_NOT_FOUND do alias e mesmo assim sai 0 — sem
  // esta checagem a sonda ficaria verde justamente no modo de falha que ela
  // existe para pegar.
  if (/Cannot find module|MODULE_NOT_FOUND/.test(saida)) {
    throw new ProbeError(
      `drizzle-kit generate (${nome}) não carregou o schema (alias do tsconfig não resolvido):\n${saida.slice(-2000)}`,
    );
  }
}

/** O `.sql` recém-criado em `out` cujo nome termina em `_<nome>.sql`. */
function lerMigrationGerada(out: string, nome: string): string {
  const arquivos = readdirSync(join(ROOT, out)).filter((f) => f.endsWith(`_${nome}.sql`));
  exigir(arquivos.length === 1, `esperava 1 arquivo _${nome}.sql em ${out}, achei ${arquivos.length}`);
  return readFileSync(join(ROOT, out, arquivos[0] as string), 'utf8');
}

/** Statements do formato do drizzle-kit, separados pelo marcador que ele emite. */
function statements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * O SQL do `up` só pode conter esses literais se o CLI tiver atravessado o
 * alias `@/shared/audience.js`. É esta função que torna a sonda incapaz de
 * ficar verde com um loader quebrado.
 */
function exigirAliasResolvido(sqlUp: string): void {
  exigir(
    sqlUp.includes(`CREATE TABLE "${TABELA_DO_ALIAS}"`),
    `SQL gerado não tem a tabela ${TABELA_DO_ALIAS} — o schema não carregou inteiro`,
  );
  const faltando = [...AUDIENCE_TYPES, ...TRUST_LEVELS].filter((v) => !sqlUp.includes(`'${v}'`));
  exigir(
    faltando.length === 0,
    `SQL gerado não tem os literais que vêm de @/shared/audience.js: ${faltando.join(', ')}`,
  );
}

interface Alvo {
  manutencao: string;
  descartavel: string;
  nomeDoBanco: string;
}

/**
 * Deriva do env o par (URL de manutenção, URL do banco descartável). Nunca
 * devolve a URL original: o banco de `DATABASE_URL` pode ser compartilhado, e
 * esta sonda faz DDL destrutivo.
 */
function alvoDescartavel(): Alvo {
  const bruto =
    process.env['PROBE_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? process.env['TEST_DB_URL'];
  exigir(
    typeof bruto === 'string' && bruto.length > 0,
    'defina DATABASE_URL (ou TEST_DB_URL / PROBE_DATABASE_URL) apontando para um Postgres alcançável',
  );
  const url = new URL(bruto);
  const nomeDoBanco = `drizzle_kit_probe_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const manutencao = new URL(url.toString());
  manutencao.pathname = '/postgres';
  const descartavel = new URL(url.toString());
  descartavel.pathname = `/${nomeDoBanco}`;
  return { manutencao: manutencao.toString(), descartavel: descartavel.toString(), nomeDoBanco };
}

async function comCliente<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function contarTabelas(client: pg.Client): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function aplicar(client: pg.Client, sql: string, rotulo: string): Promise<number> {
  const sts = statements(sql);
  exigir(sts.length > 0, `migration ${rotulo} veio vazia`);
  for (const [i, st] of sts.entries()) {
    try {
      await client.query(st);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProbeError(`${rotulo}: statement ${i + 1}/${sts.length} falhou: ${msg}\n${st.slice(0, 400)}`);
    }
  }
  return sts.length;
}

async function main(): Promise<void> {
  exigir(
    existsSync(join(ROOT, SCHEMA)) && existsSync(join(ROOT, 'tsconfig.json')),
    `rode a sonda da raiz do repo: ${SCHEMA} e tsconfig.json precisam existir em ${ROOT}`,
  );

  const { bin, versao } = resolverBinarioLocal();
  log('drizzle_kit.resolvido', { versao, bin });

  const out = join('node_modules', '.cache', `drizzle-kit-probe-${randomBytes(6).toString('hex')}`);
  const schemaVazio = join(out, '__schema-vazio.ts');
  const alvo = alvoDescartavel();

  mkdirSync(join(ROOT, out), { recursive: true });

  let bancoCriado = false;
  try {
    // ---- generate (up) ------------------------------------------------
    gerar(bin, SCHEMA, out, 'up');
    const sqlUp = lerMigrationGerada(out, 'up');
    exigirAliasResolvido(sqlUp);
    const tabelasNoSql = (sqlUp.match(/^CREATE TABLE "/gm) ?? []).length;
    exigir(
      tabelasNoSql >= MINIMO_DE_TABELAS,
      `SQL gerado tem só ${tabelasNoSql} CREATE TABLE (piso ${MINIMO_DE_TABELAS}) — schema carregou pela metade`,
    );
    log('generate.up', { bytes: sqlUp.length, tabelas: tabelasNoSql });

    // ---- banco descartável --------------------------------------------
    await comCliente(alvo.manutencao, async (c) => {
      await c.query(`CREATE DATABASE "${alvo.nomeDoBanco}"`);
    });
    bancoCriado = true;
    log('banco.criado', { banco: alvo.nomeDoBanco });

    // ---- up + down ------------------------------------------------------
    await comCliente(alvo.descartavel, async (c) => {
      exigir((await contarTabelas(c)) === 0, 'banco descartável não nasceu vazio');

      const aplicadasUp = await aplicar(c, sqlUp, 'up');
      const depoisDoUp = await contarTabelas(c);
      exigir(
        depoisDoUp >= MINIMO_DE_TABELAS,
        `up aplicou mas só ${depoisDoUp} tabelas existem (piso ${MINIMO_DE_TABELAS})`,
      );
      log('up.aplicado', { statements: aplicadasUp, tabelas: depoisDoUp });

      // O CHECK derivado do alias tem de existir NO BANCO, não só no texto.
      const checks = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint
           WHERE conrelid = $1::regclass AND contype = 'c'`,
        [TABELA_DO_ALIAS],
      );
      exigir(
        Number(checks.rows[0]?.n ?? '0') >= 2,
        `${TABELA_DO_ALIAS} aplicou sem os CHECKs de audience/trust`,
      );

      // ---- generate (down) --------------------------------------------
      // Schema VAZIO contra o snapshot que o próprio CLI acabou de gravar: o
      // diff é a migration reversa. É o round-trip do gerador, não um
      // `DROP SCHEMA` escrito à mão por esta sonda.
      writeFileSync(join(ROOT, schemaVazio), 'export {};\n', 'utf8');
      gerar(bin, schemaVazio, out, 'down');
      const sqlDown = lerMigrationGerada(out, 'down');
      const drops = (sqlDown.match(/^DROP TABLE "/gm) ?? []).length;
      exigir(
        drops === tabelasNoSql,
        `down tem ${drops} DROP TABLE para ${tabelasNoSql} CREATE TABLE — o round-trip não fecha`,
      );
      log('generate.down', { bytes: sqlDown.length, drops });

      const aplicadasDown = await aplicar(c, sqlDown, 'down');
      const depoisDoDown = await contarTabelas(c);
      exigir(depoisDoDown === 0, `down aplicou e ainda sobraram ${depoisDoDown} tabelas`);
      log('down.aplicado', { statements: aplicadasDown, tabelas: depoisDoDown });
    });

    log('probe.ok', { versao, banco: alvo.nomeDoBanco });
  } finally {
    rmSync(join(ROOT, out), { recursive: true, force: true });
    if (bancoCriado) {
      await comCliente(alvo.manutencao, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${alvo.nomeDoBanco}" WITH (FORCE)`);
      });
      log('banco.derrubado', { banco: alvo.nomeDoBanco });
    }
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n✖ sonda do drizzle-kit reprovou\n${msg}\n`);
    process.exit(1);
  },
);
