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

d('repos leak suite', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('contasRepo.byEntities returns only in-scope contas', async () => {
    const c = await pool.connect();
    try {
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await mkConta(c, a.id, { apelido: 'A1' });
      await mkConta(c, a.id, { apelido: 'A2' });
      await mkConta(c, b.id, { apelido: 'B1' });
      const { contasRepo } = await loadRepos();
      const out = await contasRepo.byEntities({ pessoa_id: 'irrelevant', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
      expect(out.length).toBe(2);
    } finally {
      // Cleanup is achieved via ON DELETE CASCADE / final teardown — keeping
      // tests inside transactions would isolate from the live `db` pool.
      c.release();
    }
  });

  it('transacoesRepo.byScope filters by entity scope', async () => {
    const c = await pool.connect();
    try {
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      const ca = await mkConta(c, a.id);
      const cb = await mkConta(c, b.id);
      await mkTransacao(c, a.id, ca.id, { descricao: 'A1' });
      await mkTransacao(c, b.id, cb.id, { descricao: 'B1' });
      const { transacoesRepo } = await loadRepos();
      const out = await transacoesRepo.byScope({ pessoa_id: 'x', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      c.release();
    }
  });

  it('contrapartesRepo.byScope filters by entity scope', async () => {
    const c = await pool.connect();
    try {
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await mkContraparte(c, a.id, { nome: 'cpA' });
      await mkContraparte(c, b.id, { nome: 'cpB' });
      const { contrapartesRepo } = await loadRepos();
      const out = await contrapartesRepo.byScope({ pessoa_id: 'x', entidades: [a.id] });
      expect(out.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
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
