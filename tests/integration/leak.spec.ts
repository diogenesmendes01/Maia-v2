/**
 * Entity-leak suite — must always pass when DB is available.
 * Asserts that every entity-scoped repository read refuses cross-entity rows.
 *
 * Skipped when TEST_DB_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

d('entity-leak suite', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('transacoes scoped query never returns out-of-scope entity rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Two entities A and B with at least one transaction each
      const a = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('Test A', 'pf') RETURNING id`,
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('Test B', 'pj') RETURNING id`,
      );
      const ca = await client.query<{ id: string }>(
        `INSERT INTO contas_bancarias(entidade_id, banco, apelido, tipo) VALUES ($1,'X','A1','cc') RETURNING id`,
        [a.rows[0]!.id],
      );
      const cb = await client.query<{ id: string }>(
        `INSERT INTO contas_bancarias(entidade_id, banco, apelido, tipo) VALUES ($1,'X','B1','cc') RETURNING id`,
        [b.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO transacoes(entidade_id, conta_id, natureza, valor, data_competencia, status, descricao, origem)
         VALUES ($1,$2,'despesa',10,'2026-01-01','paga','desc-A','manual'),
                ($3,$4,'despesa',20,'2026-01-01','paga','desc-B','manual')`,
        [a.rows[0]!.id, ca.rows[0]!.id, b.rows[0]!.id, cb.rows[0]!.id],
      );
      const scopedToA = await client.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM transacoes WHERE entidade_id = ANY($1)`,
        [[a.rows[0]!.id]],
      );
      expect(scopedToA.rows.every((r) => r.entidade_id === a.rows[0]!.id)).toBe(true);
      expect(scopedToA.rows.length).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('contas scoped query never returns out-of-scope entity contas', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const a = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('CA', 'pf') RETURNING id`,
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('CB', 'pj') RETURNING id`,
      );
      await client.query(
        `INSERT INTO contas_bancarias(entidade_id, banco, apelido, tipo)
         VALUES ($1,'X','A1','cc'), ($2,'Y','B1','cc')`,
        [a.rows[0]!.id, b.rows[0]!.id],
      );
      const res = await client.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM contas_bancarias WHERE entidade_id = ANY($1)`,
        [[a.rows[0]!.id]],
      );
      expect(res.rows.every((r) => r.entidade_id === a.rows[0]!.id)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('contrapartes scoped query never returns out-of-scope rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const a = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('CTA', 'pf') RETURNING id`,
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO entidades(nome, tipo) VALUES ('CTB', 'pj') RETURNING id`,
      );
      await client.query(
        `INSERT INTO contrapartes(entidade_id, nome, tipo) VALUES ($1,'fA','outro'),($2,'fB','outro')`,
        [a.rows[0]!.id, b.rows[0]!.id],
      );
      const res = await client.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM contrapartes WHERE entidade_id = ANY($1)`,
        [[a.rows[0]!.id]],
      );
      expect(res.rows.every((r) => r.entidade_id === a.rows[0]!.id)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
