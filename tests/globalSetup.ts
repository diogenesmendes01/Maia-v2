/**
 * Issue #571 — provisiona a infra isolada da worktree, uma vez por rodada.
 *
 * `tests/setup.ts` roda em CADA worker e só reescreve variáveis de ambiente.
 * Criar banco e aplicar 125 migrations é trabalho de uma vez só, e é aqui.
 *
 * O que este arquivo faz, e só quando `TEST_DB_URL` está definida (ou seja,
 * quando a rodada realmente quer banco ao vivo):
 *
 *  1. cria o banco `<base>_wt_<slug>` se ele não existir;
 *  2. aplica as migrations DESTA worktree nele — o que leva o ledger
 *     `schema_migrations` junto, que é a metade do problema da #571: sem banco
 *     próprio, duas árvores com migrations diferentes brigam pelo mesmo
 *     registro de "aplicada";
 *  3. limpa o db lógico do Redis da worktree, para que resíduo de uma rodada
 *     anterior (`bull:agent:*` é o caso documentado no `vitest.config.ts`) não
 *     seja lido como resultado desta.
 *
 * Fora de uma worktree ligada (checkout principal, CI) NADA disso roda: o
 * escopo é `null` e o comportamento é o de sempre — o CI já cria seus próprios
 * service containers e roda `npm run db:migrate` num passo dedicado.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import IORedis from 'ioredis';
import { arquivoDoPacote } from './helpers/pkg-path.js';
import {
  BASE_REDIS_URL,
  resolveWorktreeScope,
  scopedDatabaseUrl,
  scopedRedisUrl,
  type WorktreeScope,
} from './helpers/worktree-scope.js';

const run = promisify(execFile);

/** Conecta no banco de manutenção do MESMO servidor para poder criar o nosso. */
function maintenanceUrl(scopedUrl: string): string {
  const url = new URL(scopedUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

async function ensureDatabase(scopedUrl: string): Promise<void> {
  const name = databaseNameOf(scopedUrl);
  const admin = new pg.Client({ connectionString: maintenanceUrl(scopedUrl) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      // Identificador entre aspas duplas: o nome é derivado por
      // `scopedDatabaseName`, que já reduz a `[a-z0-9_]`, mas quotar é o que
      // torna a asserção verificável em vez de confiada.
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`[#571] banco de teste criado: ${name}`);
    }
  } finally {
    await admin.end();
  }
}

async function migrate(scope: WorktreeScope, scopedUrl: string): Promise<void> {
  // `require.resolve` em vez de caminho relativo: a worktree NÃO tem
  // `node_modules` próprio (instalar por worktree é proibido neste ambiente),
  // e a resolução do Node sobe a árvore até o `node_modules` da raiz. Um
  // `new URL('../../node_modules/…')` apontaria para dentro da worktree e
  // falharia — foi assim que dois specs quebraram (ver #571).
  const tsx = arquivoDoPacote('tsx', 'dist/cli.mjs', import.meta.url);
  const { stdout } = await run(process.execPath, [tsx, 'scripts/migrate.ts', 'up'], {
    cwd: scope.root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MAIA_ENV: 'development',
      DATABASE_URL: scopedUrl,
      POSTGRES_USER: new URL(scopedUrl).username,
      POSTGRES_PASSWORD: decodeURIComponent(new URL(scopedUrl).password),
      POSTGRES_DB: databaseNameOf(scopedUrl),
    },
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const outcome = stdout.trim().split('\n').at(-1) ?? '';
  console.log(`[#571] migrations em ${databaseNameOf(scopedUrl)} — ${outcome}`);
}

async function flushRedis(scope: WorktreeScope): Promise<void> {
  const url = scopedRedisUrl(process.env.REDIS_URL ?? BASE_REDIS_URL, scope);
  const client = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.flushdb();
    console.log(`[#571] redis db ${scope.redisDb} limpo`);
  } catch {
    // Redis fora do ar é o caso normal de uma rodada só de unit: as specs que
    // precisam dele já falham com mensagem própria (`assertRedisReachable`).
  } finally {
    client.disconnect();
  }
}

export async function setup(): Promise<void> {
  const scope = resolveWorktreeScope();
  if (!scope) return;
  if (!process.env.TEST_DB_URL) {
    // Sem banco ao vivo não há o que provisionar; o Redis ainda é isolado por
    // `tests/setup.ts`, mas limpá-lo aqui seria trabalho por nada.
    return;
  }

  const scopedUrl = scopedDatabaseUrl(process.env.TEST_DB_URL, scope);
  await ensureDatabase(scopedUrl);
  await migrate(scope, scopedUrl);
  await flushRedis(scope);
}
