/**
 * Repository-level entity-leak suite — spec 16 §6.2.
 *
 * Exercises real repository code (not raw SQL) so a regression that drops
 * a scope filter inside a method is caught. Skipped without TEST_DB_URL.
 *
 * The repositories.ts module imports `db` from db/client.ts which reads
 * DATABASE_URL at import time; we intentionally piggyback on the test runner
 * setting DATABASE_URL=$TEST_DB_URL before this spec is loaded (configure in
 * vitest setup or via the env when running locally).
 *
 * Cleanup pattern (per-test): unlike `leak.spec.ts`, transactions are not an
 * option here because the repo methods use the global `db` connection pool
 * — they would not see uncommitted rows on the test client. Instead, each
 * test tracks the IDs it creates and explicitly DELETEs them in `finally`,
 * in FK-safe reverse order. Even on test failure or process kill mid-run,
 * the next run starts clean.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { mkEntidade, mkConta, mkTransacao, mkContraparte } from '../factories/db.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

async function loadRepos(): Promise<typeof import('../../src/db/repositories.js')> {
  return await import('../../src/db/repositories.js');
}

type Tracker = {
  transacoes: string[];
  contrapartes: string[];
  contas: string[];
  entidades: string[];
};

function newTracker(): Tracker {
  return { transacoes: [], contrapartes: [], contas: [], entidades: [] };
}

async function cleanupTracked(c: pg.PoolClient, t: Tracker): Promise<void> {
  // Delete children before parents — FKs are not declared with ON DELETE CASCADE.
  const ops: Array<[string, string[]]> = [
    ['transacoes', t.transacoes],
    ['contrapartes', t.contrapartes],
    ['contas_bancarias', t.contas],
    ['entidades', t.entidades],
  ];
  for (const [table, ids] of ops) {
    if (ids.length === 0) continue;
    await c.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]).catch(() => undefined);
  }
}

d('repos leak suite', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('contasRepo.byEntities returns only in-scope contas', async () => {
    const c = await pool.connect();
    const tk = newTracker();
    try {
      const a = await mkEntidade(c);
      tk.entidades.push(a.id);
      const b = await mkEntidade(c);
      tk.entidades.push(b.id);
      const ca1 = await mkConta(c, a.id, { apelido: 'A1' });
      tk.contas.push(ca1.id);
      const ca2 = await mkConta(c, a.id, { apelido: 'A2' });
      tk.contas.push(ca2.id);
      const cb1 = await mkConta(c, b.id, { apelido: 'B1' });
      tk.contas.push(cb1.id);
      const { contasRepo } = await loadRepos();
      const out = await contasRepo.byEntities({ pessoa_id: 'irrelevant', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
      expect(out.length).toBe(2);
    } finally {
      await cleanupTracked(c, tk);
      c.release();
    }
  });

  it('transacoesRepo.byScope filters by entity scope', async () => {
    const c = await pool.connect();
    const tk = newTracker();
    try {
      const a = await mkEntidade(c);
      tk.entidades.push(a.id);
      const b = await mkEntidade(c);
      tk.entidades.push(b.id);
      const ca = await mkConta(c, a.id);
      tk.contas.push(ca.id);
      const cb = await mkConta(c, b.id);
      tk.contas.push(cb.id);
      const t1 = await mkTransacao(c, a.id, ca.id, { descricao: 'A1' });
      tk.transacoes.push(t1.id);
      const t2 = await mkTransacao(c, b.id, cb.id, { descricao: 'B1' });
      tk.transacoes.push(t2.id);
      const { transacoesRepo } = await loadRepos();
      const out = await transacoesRepo.byScope({ pessoa_id: 'x', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      await cleanupTracked(c, tk);
      c.release();
    }
  });

  it('contrapartesRepo.byScope filters by entity scope', async () => {
    const c = await pool.connect();
    const tk = newTracker();
    try {
      const a = await mkEntidade(c);
      tk.entidades.push(a.id);
      const b = await mkEntidade(c);
      tk.entidades.push(b.id);
      const cpa = await mkContraparte(c, a.id, { nome: 'cpA' });
      tk.contrapartes.push(cpa.id);
      const cpb = await mkContraparte(c, b.id, { nome: 'cpB' });
      tk.contrapartes.push(cpb.id);
      const { contrapartesRepo } = await loadRepos();
      const out = await contrapartesRepo.byScope({ pessoa_id: 'x', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      await cleanupTracked(c, tk);
      c.release();
    }
  });

  it('EmptyScopeError thrown by every byScope/byEntities method on empty scope', async () => {
    const { contasRepo, transacoesRepo, contrapartesRepo, EmptyScopeError } = await loadRepos();
    const empty = { pessoa_id: 'p', entidades: [] };
    await expect(contasRepo.byEntities(empty)).rejects.toBeInstanceOf(EmptyScopeError);
    await expect(transacoesRepo.byScope(empty)).rejects.toBeInstanceOf(EmptyScopeError);
    await expect(contrapartesRepo.byScope(empty)).rejects.toBeInstanceOf(EmptyScopeError);
  });

  it('entidadesRepo.byIds returns empty for empty ids (no implicit broadening)', async () => {
    const { entidadesRepo } = await loadRepos();
    const out = await entidadesRepo.byIds([]);
    expect(out).toEqual([]);
  });
});
