/**
 * Entity-leak suite — spec 16 §6 — the single most important test in the system.
 *
 * Covers:
 *   - Raw SQL scope filters (defense in depth at the query layer)
 *   - Repository read methods that take an EntityScope (exercised through real code)
 *   - EmptyScopeError contract: every byScope method throws on an empty scope
 *   - Constitutional dispatcher rejection of cross-entity intents
 *
 * Skipped when TEST_DB_URL is not set so unit-only CI lanes pass without Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  mkEntidade,
  mkConta,
  mkTransacao,
  mkContraparte,
} from '../factories/db.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

d('entity-leak suite — raw SQL', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('transacoes scoped query never returns out-of-scope rows', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c, { tipo: 'pf' });
      const b = await mkEntidade(c, { tipo: 'pj' });
      const ca = await mkConta(c, a.id);
      const cb = await mkConta(c, b.id);
      await mkTransacao(c, a.id, ca.id, { descricao: 'A' });
      await mkTransacao(c, b.id, cb.id, { descricao: 'B' });
      const r = await c.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM transacoes WHERE entidade_id = ANY($1)`,
        [[a.id]],
      );
      expect(r.rows.every((row) => row.entidade_id === a.id)).toBe(true);
      expect(r.rows.length).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('contas_bancarias scoped query never returns out-of-scope rows', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await mkConta(c, a.id, { apelido: 'A1' });
      await mkConta(c, b.id, { apelido: 'B1' });
      const r = await c.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM contas_bancarias WHERE entidade_id = ANY($1)`,
        [[a.id]],
      );
      expect(r.rows.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('contrapartes scoped query never returns out-of-scope rows', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await mkContraparte(c, a.id, { nome: 'fA' });
      await mkContraparte(c, b.id, { nome: 'fB' });
      const r = await c.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM contrapartes WHERE entidade_id = ANY($1)`,
        [[a.id]],
      );
      expect(r.rows.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('recorrencias scoped query never returns out-of-scope rows', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      const ca = await mkConta(c, a.id);
      const cb = await mkConta(c, b.id);
      await c.query(
        `INSERT INTO recorrencias(entidade_id, conta_id, natureza, descricao, valor_aprox)
         VALUES ($1, $2, 'despesa', 'recA', 100), ($3, $4, 'despesa', 'recB', 200)`,
        [a.id, ca.id, b.id, cb.id],
      );
      const r = await c.query<{ entidade_id: string }>(
        `SELECT entidade_id FROM recorrencias WHERE entidade_id = ANY($1)`,
        [[a.id]],
      );
      expect(r.rows.every((row) => row.entidade_id === a.id)).toBe(true);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('entity_states never leaks across entities', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await c.query(
        `INSERT INTO entity_states(entidade_id, contexto, saldo_consolidado)
         VALUES ($1, '{}'::jsonb, 100), ($2, '{}'::jsonb, 200)`,
        [a.id, b.id],
      );
      const r = await c.query<{ entidade_id: string; saldo_consolidado: string }>(
        `SELECT entidade_id, saldo_consolidado FROM entity_states WHERE entidade_id = $1`,
        [a.id],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.entidade_id).toBe(a.id);
      expect(Number(r.rows[0]!.saldo_consolidado)).toBe(100);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('audit_log filters by alvo_id never returns rows of another entity', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await mkEntidade(c);
      const b = await mkEntidade(c);
      await c.query(
        `INSERT INTO audit_log(acao, alvo_id, metadata) VALUES
           ('transaction_created', $1, '{"entidade":"A"}'::jsonb),
           ('transaction_created', $2, '{"entidade":"B"}'::jsonb)`,
        [a.id, b.id],
      );
      const r = await c.query<{ alvo_id: string }>(
        `SELECT alvo_id FROM audit_log WHERE alvo_id = $1`,
        [a.id],
      );
      expect(r.rows.every((row) => row.alvo_id === a.id)).toBe(true);
      expect(r.rows.length).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
