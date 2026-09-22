/**
 * Migration 147 (`agent_canary_policy`, P12) contra Postgres REAL: up,
 * catálogo, CHECKs de lastro, down, up de novo.
 *
 * O que este arquivo guarda:
 *
 *  1. **O catálogo tem o que a escada promete.** PK (tenant, agente), o CHECK
 *     fechado dos sete degraus do §10.1 e `row_version` nascendo 1.
 *  2. **Os CHECKs de LASTRO mordem.** Degrau a partir de `live_informational`
 *     sem coorte é recusado pelo banco; degrau a partir de `shadow_offline`
 *     sem evidência de aceite também. É a duplicação deliberada de
 *     `validateCanaryPolicy`: o TypeScript recusa cedo e explica, o banco
 *     recusa sempre — inclusive o `UPDATE` feito à mão.
 *  3. **O `_down` recusa enquanto houver degrau acima de `off`**, e a recusa é
 *     total (envelope BEGIN/COMMIT): a tabela e a linha continuam lá. A
 *     evidência de aceite é o artefato que o §10 exige que exista; um rollback
 *     que a apagasse apagaria a prova junto com a decisão.
 *  4. **Com só `off`, o `_down` derruba a tabela**, e o up recria.
 *
 * TODO o SQL vem de `migrations/` pelo discovery de produção
 * (`src/migrations/discover.ts`) — um teste que escrevesse o próprio DDL
 * aferiria a si mesmo.
 *
 * Isolamento: schema dedicado por execução, primeiro no `search_path`, como
 * `migration-145-agent-engine-policies-real-db.spec.ts`. Esta tabela não tem
 * FK, então não depende de `public`. Como o down usa nome sem schema, ele só
 * roda depois de conferido que a tabela do schema dedicado existe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  discoverMigrations,
  downSiblingOf,
  splitTopLevelStatements,
} from '@/migrations/discover.js';
import type { MigrationArtifact } from '@/migrations/types.js';
import { CANARY_STAGES } from '@/runtime/engines/canary-policy.js';

const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

const UP_ID = '147_agent_canary_policy.sql';
const DOWN_ID = downSiblingOf(UP_ID);

const SCHEMA = `maia_mig147_${Math.random().toString(36).slice(2, 10)}`;
const TABELA = `${SCHEMA}.agent_canary_policy`;

const TENANT = 'mig147-tenant';
const AGENT = 'mig147-agent';

let client: pg.Client;
let artifact: MigrationArtifact;
let downSql: string;

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
  // resolveria para `public.agent_canary_policy`.
  expect(await tabelaExiste()).toBe(true);
  return runLikePsql(downSql);
}

async function inserir(input: {
  stage: string;
  cohort?: string | null;
  aceite?: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO ${TABELA} (tenant_id, agent_id, stage, cohort_ref, acceptance_evidence_ref, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'app-user-1')`,
    [TENANT, AGENT, input.stage, input.cohort ?? null, input.aceite ?? null],
  );
}

d('migration 147 — agent_canary_policy contra Postgres real (P12)', () => {
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
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS ${TABELA}`);
    await up();
    expect(await tabelaExiste()).toBe(true);
  });

  it('o catálogo tem PK, CHECK dos degraus e row_version começando em 1', async () => {
    const cons = await client.query<{ conname: string; contype: string; def: string }>(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
      [TABELA],
    );
    const por = new Map(cons.rows.map((r) => [r.conname, r]));

    expect(por.get('agent_canary_policy_pk')).toMatchObject({
      contype: 'p',
      def: 'PRIMARY KEY (tenant_id, agent_id)',
    });
    for (const nome of [
      'agent_canary_policy_stage_chk',
      'agent_canary_policy_cohort_chk',
      'agent_canary_policy_acceptance_chk',
      'agent_canary_policy_row_version_chk',
      'agent_canary_policy_updated_by_chk',
      'agent_canary_policy_scope_chk',
    ]) {
      expect(por.get(nome)?.contype, nome).toBe('c');
    }

    await inserir({ stage: 'off' });
    const r = await client.query<{ row_version: string }>(`SELECT row_version FROM ${TABELA}`);
    expect(r.rows).toEqual([{ row_version: '1' }]);
  });

  it('o CHECK do degrau conhece exatamente os degraus de CANARY_STAGES', async () => {
    // A escada em código e a lista fechada no banco são a MESMA ordem. Um
    // degrau novo em um lado e não no outro é configuração que o código
    // entende e o banco recusa, ou o contrário — e os dois sintomas aparecem
    // só em produção.
    for (const stage of CANARY_STAGES) {
      await client.query(`DELETE FROM ${TABELA}`);
      await inserir({ stage, cohort: 'coorte-1', aceite: 'aceite-1' });
    }
    await client.query(`DELETE FROM ${TABELA}`);
    await expect(inserir({ stage: 'degrau_inventado', cohort: 'c', aceite: 'a' })).rejects.toThrow(
      /agent_canary_policy_stage_chk/,
    );
  });

  it('degrau com gente de verdade EXIGE coorte', async () => {
    await expect(inserir({ stage: 'live_informational', aceite: 'aceite-1' })).rejects.toThrow(
      /agent_canary_policy_cohort_chk/,
    );
    // Abaixo de `live_informational` não há coorte a exigir.
    await inserir({ stage: 'shadow_offline', aceite: 'aceite-1' });
  });

  it('degrau que sai do laboratório EXIGE evidência de aceite', async () => {
    await expect(inserir({ stage: 'shadow_offline' })).rejects.toThrow(
      /agent_canary_policy_acceptance_chk/,
    );
    // `off` e `synthetic` não têm o que aceitar.
    await inserir({ stage: 'synthetic' });
  });

  it('o `_down` RECUSA com degrau acima de off, e a recusa é total', async () => {
    await inserir({ stage: 'live_informational', cohort: 'coorte-1', aceite: 'aceite-1' });
    const r = await down();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/down da 147 recusado: 1 agente\(s\) com degrau acima de off/);
    }

    expect(await tabelaExiste()).toBe(true);
    const linhas = await client.query(`SELECT stage FROM ${TABELA}`);
    expect(linhas.rows).toEqual([{ stage: 'live_informational' }]);
  });

  it('com só off o `_down` derruba a tabela, e o up recria', async () => {
    await inserir({ stage: 'off' });
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
    expect(DOWN_ID).toBe('147_agent_canary_policy_down.sql');
  });
});
