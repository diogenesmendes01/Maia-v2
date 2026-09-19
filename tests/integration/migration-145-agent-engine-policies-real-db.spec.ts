/**
 * Migration 145 (`agent_engine_policies`, K-15) contra Postgres REAL: up,
 * catálogo, down, up de novo.
 *
 * O que este arquivo guarda:
 *
 *  1. **O catálogo tem o que a política promete.** PK (tenant, agente, canal),
 *     CHECK do enum de engine, FK COMPOSTA para `channels (tenant_id,
 *     agent_id, id)` e `row_version` nascendo 1.
 *  2. **O `_down` recusa enquanto houver linha `hermes`**, e a recusa é total
 *     (envelope BEGIN/COMMIT): a tabela e a linha continuam lá.
 *  3. **Com só `maia_react`, o `_down` derruba a tabela**, e o up recria.
 *
 * TODO o SQL vem de `migrations/` pelo discovery de produção
 * (`src/migrations/discover.ts`) — um teste que escrevesse o próprio DDL
 * aferiria a si mesmo.
 *
 * Isolamento: schema dedicado por execução, primeiro no `search_path`, como
 * `migration-119-signature-version.spec.ts`. `channels` vem do `public` (a FK
 * precisa do unique de suporte da 090). Como o down usa nome sem schema, ele
 * só roda depois de conferido que a tabela do schema dedicado existe — senão o
 * nome resolveria para a tabela do `public`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  discoverMigrations,
  downSiblingOf,
  splitTopLevelStatements,
} from '@/migrations/discover.js';
import type { MigrationArtifact } from '@/migrations/types.js';

const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

const UP_ID = '145_agent_engine_policies.sql';
const DOWN_ID = downSiblingOf(UP_ID);

const SCHEMA = `maia_mig145_${Math.random().toString(36).slice(2, 10)}`;
const TABELA = `${SCHEMA}.agent_engine_policies`;

const TENANT = 'mig145-tenant';
const AGENT = 'mig145-agent';

let client: pg.Client;
let artifact: MigrationArtifact;
let downSql: string;
let canal: string;

/** `psql -v ON_ERROR_STOP=1 -f`: um statement por vez, parando no primeiro erro. */
async function runLikePsql(
  sql: string,
): Promise<{ ok: true } | { ok: false; index: number; message: string }> {
  const stmts = splitTopLevelStatements(sql);
  for (let i = 0; i < stmts.length; i++) {
    try {
      await client.query(stmts[i]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, index: i, message: (err as Error).message };
    }
  }
  return { ok: true };
}

async function tabelaExiste(): Promise<boolean> {
  const r = await client.query<{ oid: string | null }>('SELECT to_regclass($1)::text AS oid', [
    TABELA,
  ]);
  return r.rows[0]!.oid !== null;
}

async function up(): Promise<void> {
  const m = artifact.byId.get(UP_ID);
  if (!m) throw new Error(`${UP_ID} não encontrada pelo discovery de produção`);
  expect(await runLikePsql(m.sql)).toEqual({ ok: true });
}

async function down() {
  // Guarda: sem a tabela do schema dedicado, o nome sem schema do down
  // resolveria para `public.agent_engine_policies`.
  expect(await tabelaExiste()).toBe(true);
  return runLikePsql(downSql);
}

async function inserir(engine: string): Promise<void> {
  await client.query(
    `INSERT INTO ${TABELA} (tenant_id, agent_id, channel_id, engine, updated_by)
     VALUES ($1, $2, $3, $4, 'app-user-1')`,
    [TENANT, AGENT, canal, engine],
  );
}

d('migration 145 — agent_engine_policies contra Postgres real (K-15)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    const cs = await client.query<{ s: string }>('SELECT current_schema() AS s');
    expect(cs.rows[0]!.s).toBe(SCHEMA);

    artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    expect(artifact.byId.get(UP_ID)?.hasDownSibling).toBe(true);
    downSql = await readFile(join(process.cwd(), 'migrations', DOWN_ID), 'utf8');

    await client.query(
      'INSERT INTO public.tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING',
      [TENANT],
    );
    await client.query(
      'INSERT INTO public.agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING',
      [AGENT, TENANT],
    );
    const c = await client.query<{ id: string }>(
      `INSERT INTO public.channels (tenant_id, agent_id, channel_type, external_id, active)
       VALUES ($1, $2, 'web', $3, true) RETURNING id`,
      [TENANT, AGENT, `mig145-${randomUUID()}`],
    );
    canal = c.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query('DELETE FROM public.channels WHERE id = $1', [canal]).catch(() => undefined);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS ${TABELA}`);
    await up();
    expect(await tabelaExiste()).toBe(true);
  });

  it('o catálogo tem PK, CHECK do enum, FK composta e row_version começando em 1', async () => {
    const cons = await client.query<{ conname: string; contype: string; def: string }>(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
      [TABELA],
    );
    const por = new Map(cons.rows.map((r) => [r.conname, r]));

    expect(por.get('agent_engine_policies_pk')).toMatchObject({
      contype: 'p',
      def: 'PRIMARY KEY (tenant_id, agent_id, channel_id)',
    });
    expect(por.get('agent_engine_policies_engine_chk')?.contype).toBe('c');
    expect(por.get('agent_engine_policies_engine_chk')?.def).toMatch(/maia_react.*hermes/s);
    const fk = por.get('agent_engine_policies_channel_fk');
    expect(fk?.contype).toBe('f');
    expect(fk?.def).toMatch(
      /^FOREIGN KEY \(tenant_id, agent_id, channel_id\) REFERENCES (public\.)?channels\(tenant_id, agent_id, id\) ON DELETE RESTRICT$/,
    );
    for (const nome of [
      'agent_engine_policies_row_version_chk',
      'agent_engine_policies_updated_by_chk',
      'agent_engine_policies_scope_chk',
    ]) {
      expect(por.get(nome)?.contype, nome).toBe('c');
    }

    const idx = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'agent_engine_policies'`,
      [SCHEMA],
    );
    expect(idx.rows.map((r) => r.indexdef)).toEqual([
      expect.stringMatching(
        /^CREATE UNIQUE INDEX agent_engine_policies_pk ON \S+ USING btree \(tenant_id, agent_id, channel_id\)$/,
      ),
    ]);

    await inserir('hermes');
    const r = await client.query<{ row_version: string }>(`SELECT row_version FROM ${TABELA}`);
    expect(r.rows).toEqual([{ row_version: '1' }]);
  });

  it('o `_down` RECUSA com linha hermes, e a recusa é total', async () => {
    await inserir('hermes');
    const r = await down();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/down da 145 recusado: 1 politica\(s\) com engine=hermes/);

    expect(await tabelaExiste()).toBe(true);
    const linhas = await client.query(`SELECT engine FROM ${TABELA}`);
    expect(linhas.rows).toEqual([{ engine: 'hermes' }]);
  });

  it('com só maia_react o `_down` derruba a tabela, e o up recria', async () => {
    await inserir('maia_react');
    expect(await down()).toEqual({ ok: true });
    expect(await tabelaExiste()).toBe(false);

    await up();
    expect(await tabelaExiste()).toBe(true);
    // Up repetido é no-op, não erro.
    await up();
    const linhas = await client.query(`SELECT count(*)::int AS n FROM ${TABELA}`);
    expect(linhas.rows).toEqual([{ n: 0 }]);
  });

  it('o par `_up`/`_down` que o discovery resolve é o desta migration', () => {
    expect(DOWN_ID).toBe('145_agent_engine_policies_down.sql');
  });
});
