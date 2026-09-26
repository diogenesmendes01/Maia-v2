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
 * esta spec NUNCA dá `FLUSHDB`. O par Redis exige reserva explícita do operador;
 * um slot vazio ou derivado implicitamente NÃO comprova autorização.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import IORedis from 'ioredis';
import pg from 'pg';
import { DisposableDatabase } from '../helpers/disposable-database.js';
import { readCanaryRedisAllocation } from '../helpers/canary-redis-allocation.js';
import { applyMigrations } from './_fixtures/postgres-testcontainer.js';
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
const databases: DisposableDatabase[] = [];
const redis: IORedis[] = [];
const canario = randomUUID();

d('#571 — duas worktrees não se enxergam (canários em Postgres e Redis)', () => {
  beforeAll(async () => {
    // Fail before connections or CREATE, even outside the dedicated recipe.
    const allocated = readCanaryRedisAllocation();
    await assertIntegrationDeps();
    repo = criarRepoDeSonda();
    const roots = [repo.criarWorktree('wt-canario-a'), repo.criarWorktree('wt-canario-b')];
    // Seed ONLY this disposable repo's registry from the operator reservation.
    // Real resolver/probes must return those exact destinations, not implicit slots.
    mkdirSync(repo.dirDeSlots, { recursive: true });
    for (const [i, destination] of allocated.entries()) {
      writeFileSync(join(repo.dirDeSlots, new URL(destination).pathname.slice(1)), roots[i], {
        flag: 'wx',
      });
    }
    // As sondas herdam TEST_DB_URL/REDIS_URL desta rodada e devolvem o
    // ambiente que USARIAM — é contra esses destinos que os canários vão.
    const baseUrl = new URL(process.env.TEST_DB_URL!);
    baseUrl.pathname = '/card_canary';
    sondas = await rodarSondas(roots, {
      TEST_DB_URL: baseUrl.toString(),
      DATABASE_URL: baseUrl.toString(),
      REDIS_URL: allocated[0],
    });

    for (const [i, s] of sondas.entries()) {
      expect(s.ok, s.erro).toBe(true);
      expect(s.ambiente?.REDIS_URL).toBe(allocated[i]);
      expect(s.escopo?.redisDb).toBe(Number(new URL(allocated[i]).pathname.slice(1)));
    }
    for (const s of sondas) {
      expect(s.escopo, 'a sonda caiu no caminho scope === null').not.toBeNull();
      const url = s.ambiente?.DATABASE_URL ?? '';
      const database = new DisposableDatabase(
        url,
        `${canario}:${databases.length}`,
        process.env,
        'card_fixture',
        new URL(url).pathname.slice(1),
      );
      databases.push(database);
      await database.create();
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        expect(await applyMigrations(pool)).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
      const cliente = new pg.Client({ connectionString: url });
      await cliente.connect();
      clientes.push(cliente);
      redis.push(new IORedis(s.ambiente?.REDIS_URL ?? ''));
      const identity = await cliente.query(
        'SELECT oid FROM pg_database WHERE datname = current_database()',
      );
      const ledger = await cliente.query('SELECT count(*)::int AS count FROM schema_migrations');
      console.info(
        'CANARY_RESOURCE',
        JSON.stringify({
          uid: process.getuid?.(),
          database: database.name,
          oid: identity.rows[0].oid,
          migrations: ledger.rows[0].count,
          redis: s.ambiente?.REDIS_URL,
        }),
      );
    }
  }, PRAZO);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const [i, r] of redis.entries()) {
      try {
        await r.del(`maia:wt571:canario:${canario}:${i}`);
        expect(await r.exists(`maia:wt571:canario:${canario}:${i}`)).toBe(0);
      } catch (error) {
        errors.push(error);
      } finally {
        r.disconnect();
      }
    }
    for (const c of clientes) await c.end().catch((error: unknown) => errors.push(error));
    for (const database of databases) {
      try {
        await database.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    repo?.destruir();
    if (errors.length) throw new AggregateError(errors, 'Canary owned-resource cleanup failed');
    console.info(
      'CANARY_CLEANUP',
      JSON.stringify({ databases: databases.map((d) => d.name), redisKeysRemoved: redis.length }),
    );
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
    const initialA = await a.query<{ version: string }>(
      'SELECT id AS version FROM schema_migrations ORDER BY id',
    );
    const initialB = await b.query<{ version: string }>(
      'SELECT id AS version FROM schema_migrations ORDER BY id',
    );
    expect(initialA.rows.length).toBeGreaterThan(0);
    expect(initialA.rows).toEqual(initialB.rows);
    await a.query('INSERT INTO schema_migrations (id) VALUES ($1)', ['999_so_da_arvore_a']);
    await b.query('INSERT INTO schema_migrations (id) VALUES ($1)', ['998_so_da_arvore_b']);

    const emA = await a.query<{ version: string }>(
      'SELECT id AS version FROM schema_migrations ORDER BY id',
    );
    const emB = await b.query<{ version: string }>(
      'SELECT id AS version FROM schema_migrations ORDER BY id',
    );
    expect(emA.rows.map((r) => r.version).sort()).toEqual(
      [...initialA.rows.map((r) => r.version), '999_so_da_arvore_a'].sort(),
    );
    expect(emB.rows.map((r) => r.version).sort()).toEqual(
      [...initialB.rows.map((r) => r.version), '998_so_da_arvore_b'].sort(),
    );
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
