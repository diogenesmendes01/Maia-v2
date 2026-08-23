/**
 * Issue #571, revisão da PR #597 — canários em infra AO VIVO.
 *
 * ## O que falta provar aqui
 *
 * `tests/unit/helpers/worktree-scope-concorrencia.spec.ts` prova que duas
 * worktrees DERIVAM destinos diferentes, com processos concorrentes de
 * verdade. O que ele não pode provar sem infra é a consequência: que esses
 * destinos são de fato **não observáveis um do outro**. Esta spec fecha isso
 * do jeito mais direto que existe — escreve um canário em cada lado e afirma
 * que nenhum dos dois enxerga o do outro.
 *
 * Três eixos, os mesmos três da issue:
 *
 *  - **dados**: uma linha escrita no banco da árvore A não aparece no da B;
 *  - **ledger**: `schema_migrations` de A não contém a versão que só B aplicou
 *    (é a metade da #571 que faz duas árvores brigarem pelo registro de
 *    "aplicada");
 *  - **Redis**: uma chave no db lógico de A não é legível pelo cliente de B —
 *    e é isto que separa `bull:agent:*` de uma rodada da outra.
 *
 * ## Cuidados
 *
 * As worktrees são temporárias (`os.tmpdir()`), com `.git` próprio, então o
 * registro de slots exercitado NÃO é o do repositório real. Os bancos criados
 * levam o hash do caminho temporário no nome e são derrubados no `afterAll`.
 * As chaves de Redis carregam um sufixo aleatório e são apagadas uma a uma —
 * esta spec NUNCA dá `FLUSHDB`, porque o db lógico que ela toca pode ser o de
 * uma worktree viva na máquina de quem roda.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import pg from 'pg';
import { assertIntegrationDeps } from '../helpers/integrationSetup.js';
import {
  criarRepoDeSonda,
  rodarSondas,
  type RepoDeSonda,
  type RespostaDaSonda,
} from '../helpers/worktree-de-sonda.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/** Boot de dois processos + `CREATE DATABASE` duas vezes. */
const PRAZO = 120_000;

let repo: RepoDeSonda;
let sondas: RespostaDaSonda[];
const clientes: pg.Client[] = [];
const redis: IORedis[] = [];
const canario = randomUUID();

function urlDeManutencao(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

function nomeDoBanco(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

async function comAdmin(url: string, sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlDeManutencao(url) });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

d('#571 — duas worktrees não se enxergam (canários em Postgres e Redis)', () => {
  beforeAll(async () => {
    await assertIntegrationDeps();
    repo = criarRepoDeSonda();
    const roots = [repo.criarWorktree('wt-canario-a'), repo.criarWorktree('wt-canario-b')];
    // As sondas herdam TEST_DB_URL/REDIS_URL desta rodada e devolvem o
    // ambiente que USARIAM — é contra esses destinos que os canários vão.
    sondas = await rodarSondas(roots);

    for (const s of sondas) {
      expect(s.escopo, 'a sonda caiu no caminho scope === null').not.toBeNull();
      const url = s.ambiente?.DATABASE_URL ?? '';
      await comAdmin(url, `CREATE DATABASE "${nomeDoBanco(url).replace(/"/g, '""')}"`);
      const cliente = new pg.Client({ connectionString: url });
      await cliente.connect();
      clientes.push(cliente);
      redis.push(new IORedis(s.ambiente?.REDIS_URL ?? ''));
    }
  }, PRAZO);

  afterAll(async () => {
    for (const [i, r] of redis.entries()) {
      try {
        await r.del(`maia:wt571:canario:${canario}:${i}`);
      } catch {
        /* o db pode já estar inalcançável — a limpeza é best-effort */
      }
      r.disconnect();
    }
    for (const c of clientes) await c.end().catch(() => undefined);
    for (const s of sondas ?? []) {
      const url = s.ambiente?.DATABASE_URL ?? '';
      if (!url) continue;
      await comAdmin(url, `DROP DATABASE IF EXISTS "${nomeDoBanco(url).replace(/"/g, '""')}"`).catch(
        () => undefined,
      );
    }
    repo?.destruir();
  }, PRAZO);

  it('os destinos derivados são distintos nos três eixos', () => {
    const [a, b] = sondas;
    expect(a.ambiente?.POSTGRES_DB).not.toBe(b.ambiente?.POSTGRES_DB);
    expect(a.ambiente?.REDIS_URL).not.toBe(b.ambiente?.REDIS_URL);
    expect(a.escopo?.redisDb).not.toBe(b.escopo?.redisDb);
  });

  it('uma linha escrita no banco de A não existe no banco de B', async () => {
    const [a, b] = clientes;
    for (const c of clientes) {
      await c.query('CREATE TABLE canario_571 (marca text primary key)');
    }
    await a.query('INSERT INTO canario_571 (marca) VALUES ($1)', [`A-${canario}`]);
    await b.query('INSERT INTO canario_571 (marca) VALUES ($1)', [`B-${canario}`]);

    const emA = await a.query<{ marca: string }>('SELECT marca FROM canario_571');
    const emB = await b.query<{ marca: string }>('SELECT marca FROM canario_571');
    expect(emA.rows.map((r) => r.marca)).toEqual([`A-${canario}`]);
    expect(emB.rows.map((r) => r.marca)).toEqual([`B-${canario}`]);
  });

  it('o ledger de migrations de A não registra o que só B aplicou', async () => {
    const [a, b] = clientes;
    for (const c of clientes) {
      await c.query('CREATE TABLE schema_migrations (version text primary key)');
    }
    await a.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['999_so_da_arvore_a']);
    await b.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['998_so_da_arvore_b']);

    const emA = await a.query<{ version: string }>('SELECT version FROM schema_migrations');
    const emB = await b.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(emA.rows.map((r) => r.version)).toEqual(['999_so_da_arvore_a']);
    expect(emB.rows.map((r) => r.version)).toEqual(['998_so_da_arvore_b']);
  });

  it('uma chave no db lógico de A não é legível pelo cliente de B', async () => {
    const [a, b] = redis;
    const chaveA = `maia:wt571:canario:${canario}:0`;
    const chaveB = `maia:wt571:canario:${canario}:1`;
    await a.set(chaveA, 'arvore-a');
    await b.set(chaveB, 'arvore-b');

    expect(await a.get(chaveA)).toBe('arvore-a');
    expect(await b.get(chaveB)).toBe('arvore-b');
    // A prova de não-observabilidade: cada um é cego para a chave do outro.
    expect(await a.get(chaveB)).toBeNull();
    expect(await b.get(chaveA)).toBeNull();
  });
});
