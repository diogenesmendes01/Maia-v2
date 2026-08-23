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
 *     seja lido como resultado desta — e FALHA a rodada se não conseguir
 *     limpar, porque prosseguir é ler resíduo como resultado.
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
  databaseNameOf,
  resolveTestEnv,
  resolveWorktreeScope,
  sanitizarMensagem,
  sanitizarUrl,
  type WorktreeScope,
} from './helpers/worktree-scope.js';

const run = promisify(execFile);

/** Conecta no banco de manutenção do MESMO servidor para poder criar o nosso. */
function maintenanceUrl(scopedUrl: string): string {
  const url = new URL(scopedUrl);
  url.pathname = '/postgres';
  return url.toString();
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

/**
 * Limpa o db lógico do Redis desta worktree — e FALHA FECHADO se não
 * conseguir.
 *
 * Isto só é chamado depois de `TEST_DB_URL` estar definida, ou seja: numa
 * rodada que PEDIU infra real. A versão anterior engolia qualquer erro em
 * silêncio com a justificativa de que "Redis fora do ar é o caso normal de uma
 * rodada só de unit" — mas a rodada só de unit nem chega aqui, porque não tem
 * `TEST_DB_URL`. O que o `catch` mudo cobria de fato era o caso ruim: ACL que
 * recusa `FLUSHDB`, índice de db fora do `--databases` do servidor, Redis
 * indisponível. Nesses casos a suíte seguia lendo resíduo da rodada anterior
 * como resultado desta — que é o incidente que a issue #571 existe para
 * fechar.
 *
 * A tolerância a Redis ausente continua existindo: ela mora no caminho que NÃO
 * define `TEST_DB_URL` (`setup()` abaixo retorna antes), e nas specs que
 * precisam de Redis e falham com mensagem própria (`assertRedisReachable`).
 *
 * O diagnóstico é sanitizado: diz para onde a conexão foi, sem a senha.
 */
export async function flushRedis(url: string, redisDb: number): Promise<void> {
  const client = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    retryStrategy: () => null,
  });
  // O ioredis emite `error` no cliente ALÉM de rejeitar o `connect()`. Sem um
  // ouvinte, esse evento vira "Unhandled error event" no log — ruído que
  // esconde a mensagem abaixo, que é a que interessa.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.flushdb();
    console.log(`[#571] redis db ${redisDb} limpo (${sanitizarUrl(url)})`);
  } catch (erro) {
    const causa = sanitizarMensagem(erro instanceof Error ? erro.message : String(erro));
    throw new Error(
      [
        `#571: falhei em limpar o db ${redisDb} do Redis em ${sanitizarUrl(url)}.`,
        'Esta rodada pediu infra real (TEST_DB_URL definida) e seguir sem limpar',
        'deixaria resíduo de uma rodada anterior ser lido como resultado desta.',
        `Causa: ${causa}.`,
        'Remédio: suba a infra (`npm run test:integration:setup`), confira REDIS_URL,',
        'e garanta que a ACL permite FLUSHDB e que o índice existe no servidor',
        '(`--databases` do redis-server vs TEST_REDIS_DATABASES).',
      ].join(' '),
      { cause: erro },
    );
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

  // MESMA função que `tests/setup.ts` chama em cada worker: o banco que este
  // processo cria e o db do Redis que ele limpa são, por construção, os que a
  // rodada vai usar. Ver `resolveTestEnv` em `helpers/worktree-scope.ts`.
  const ambiente = resolveTestEnv(process.env, scope);
  await ensureDatabase(ambiente.DATABASE_URL);
  await migrate(scope, ambiente.DATABASE_URL);
  await flushRedis(ambiente.REDIS_URL, scope.redisDb);
}
