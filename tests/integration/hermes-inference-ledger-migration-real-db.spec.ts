/**
 * Migration 144 (ledger do gateway de inferência, spec §9.2) contra Postgres
 * REAL — o gate T69: up íntegro, constraints e triggers conferidos no
 * CATÁLOGO, down revisado (recusa com exposição aberta), e up de novo.
 *
 * Todo o SQL vem de `migrations/` pelo discovery de produção: um teste que
 * escrevesse o próprio DDL aferiria a si mesmo. Isolamento: schema dedicado por
 * execução (`search_path`), como `migration-119-signature-version.spec.ts`; as
 * tabelas do banco de teste compartilhado não são tocadas. As FKs para
 * `engine_runs` resolvem para o `public` já migrado.
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  discoverMigrations,
  downSiblingOf,
  splitTopLevelStatements,
} from '@/migrations/discover.js';

const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

const UP_ID = '144_hermes_inference_ledger.sql';
const DOWN_ID = downSiblingOf(UP_ID);
const SCHEMA = `maia_mig144_${Math.random().toString(36).slice(2, 10)}`;
const TABELAS = [
  'engine_budget_accounts',
  'engine_inference_attempts',
  'engine_inference_grants',
  'engine_usage_events',
];

/** Constraint esperada → tipo no catálogo (`u` unique, `c` check, `f` FK). */
const CONSTRAINTS: Record<string, 'u' | 'c' | 'f'> = {
  engine_budget_accounts_scope_chk: 'c',
  engine_budget_accounts_scope_id_uq: 'u',
  engine_budget_accounts_period_uq: 'u',
  engine_inference_grants_scope_chk: 'c',
  engine_inference_grants_scope_id_uq: 'u',
  engine_inference_grants_token_hash_uq: 'u',
  engine_inference_grants_run_fk: 'f',
  engine_inference_grants_expiry_chk: 'c',
  engine_inference_grants_revoke_chk: 'c',
  engine_inference_attempts_scope_chk: 'c',
  engine_inference_attempts_scope_id_uq: 'u',
  engine_inference_attempts_seq_uq: 'u',
  engine_inference_attempts_run_fk: 'f',
  engine_inference_attempts_grant_fk: 'f',
  engine_inference_attempts_account_fk: 'f',
  engine_inference_attempts_finished_chk: 'c',
  engine_inference_attempts_settled_chk: 'c',
  engine_inference_attempts_unknown_chk: 'c',
  engine_usage_events_scope_chk: 'c',
  engine_usage_events_key_uq: 'u',
  engine_usage_events_run_fk: 'f',
  engine_usage_events_attempt_fk: 'f',
  engine_usage_events_delta_chk: 'c',
};
const TRIGGERS = ['engine_inference_grants_guard_trg', 'engine_usage_events_append_only_trg'];

let admin: pg.Pool;
let pool: pg.Pool;
let upSql: string;
let downSql: string;

/** `psql -v ON_ERROR_STOP=1 -f`: statement a statement, na mesma conexão, para no primeiro erro. */
async function runLikePsql(sql: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const c = await pool.connect();
  try {
    for (const stmt of splitTopLevelStatements(sql)) {
      try {
        await c.query(stmt);
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return { ok: false, message: (err as Error).message };
      }
    }
    return { ok: true };
  } finally {
    c.release();
  }
}

async function tabelasPresentes(): Promise<string[]> {
  const r = await admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
    [SCHEMA],
  );
  return r.rows.map((x) => x.relname);
}

async function constraintsNoCatalogo(): Promise<Record<string, string>> {
  const r = await admin.query<{ conname: string; contype: string }>(
    `SELECT con.conname, con.contype FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1`,
    [SCHEMA],
  );
  return Object.fromEntries(r.rows.map((x) => [x.conname, x.contype]));
}

async function triggersNoCatalogo(): Promise<string[]> {
  const r = await admin.query<{ tgname: string }>(
    `SELECT t.tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1`,
    [SCHEMA],
  );
  return r.rows.map((x) => x.tgname);
}

async function conferirCatalogo(): Promise<void> {
  expect(await tabelasPresentes()).toEqual(TABELAS);
  const cat = await constraintsNoCatalogo();
  for (const [nome, tipo] of Object.entries(CONSTRAINTS)) {
    expect(cat[nome], `constraint ${nome}`).toBe(tipo);
  }
  expect(await triggersNoCatalogo()).toEqual(TRIGGERS);
}

d('migration 144 — ledger de inferência contra Postgres real (T69)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
    // SET por conexão, e não `options` na URL: nem todo servidor honra o
    // parâmetro de startup (o PGlite local não honra), e sem ele o up cairia
    // no `public` compartilhado.
    pool.on('connect', (c) => {
      void c.query(`SET search_path TO ${SCHEMA}, public`);
    });
    const artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    const up = artifact.byId.get(UP_ID);
    expect(up?.hasDownSibling).toBe(true);
    upSql = up!.sql;
    downSql = await readFile(join(process.cwd(), 'migrations', DOWN_ID), 'utf8');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('up cria as quatro tabelas com as constraints e triggers declarados', async () => {
    expect(await runLikePsql(upSql)).toEqual({ ok: true });
    await conferirCatalogo();
    // A conta tem só escopo, período, dinheiro, CAS e timestamps: nenhuma coluna inventada.
    const cols = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'engine_budget_accounts'
        ORDER BY ordinal_position`,
      [SCHEMA],
    );
    expect(cols.rows.map((x) => x.column_name)).toEqual([
      'id',
      'tenant_id',
      'agent_id',
      'period_start_utc',
      'limit_microusd',
      'reserved_microusd',
      'settled_microusd',
      'row_version',
      'created_at',
      'updated_at',
    ]);
  });

  it('down recusa com exposição reservada e não mexe em nada', async () => {
    await pool.query(
      `INSERT INTO engine_budget_accounts
         (tenant_id, agent_id, period_start_utc, limit_microusd, reserved_microusd)
       VALUES ('tenant-mig144', 'agent-mig144', current_date, 1000, 10)`,
    );
    const r = await runLikePsql(downSql);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toMatch(/down da 144 recusado/);
    await conferirCatalogo();
  });

  it('sem exposição, down remove tudo e up reconstrói igual', async () => {
    await pool.query(`UPDATE engine_budget_accounts SET reserved_microusd = 0`);
    expect(await runLikePsql(downSql)).toEqual({ ok: true });
    expect(await tabelasPresentes()).toEqual([]);
    const funcoes = await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1`,
      [SCHEMA],
    );
    expect(funcoes.rowCount).toBe(0);

    expect(await runLikePsql(upSql)).toEqual({ ok: true });
    await conferirCatalogo();
  });
});
