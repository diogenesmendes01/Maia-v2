/**
 * P84-C2 real-DB regression: verifies the partial UNIQUE index from
 * migration 023 (procedure_exec_one_in_progress_per_conversa) is actually
 * matched by procedureExecutionsRepo.createOrFindActive's ON CONFLICT
 * predicate. The repo's `where` clause must EXACTLY mirror the migration's
 * index predicate (`status = 'in_progress' AND conversa_id IS NOT NULL`) —
 * relying on Postgres' column-presence inference alone is brittle.
 *
 * Two scenarios:
 *  1. conversa_id IS NOT NULL → second concurrent insert no-ops and we
 *     re-load the existing in_progress row (created=false).
 *  2. conversa_id IS NULL → partial index doesn't apply at all (background
 *     runs); each call creates a new row (created=true).
 *
 * Skipped without TEST_DB_URL (matches `pending-gate-concurrency.spec.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

const T = 'p84-tenant';
const A = 'p84-agent';

d('procedureExecutionsRepo.createOrFindActive (real DB)', () => {
  let definition_id: string;
  let conversa_id: string;
  let pessoa_id: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query(`INSERT INTO tenants(id, nome) VALUES ($1, 'P84 Tenant') ON CONFLICT (id) DO NOTHING`, [T]);
      await c.query(
        `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, 'P84 Agent') ON CONFLICT (id) DO NOTHING`,
        [A, T],
      );
      const def = await c.query<{ id: string }>(
        `INSERT INTO procedure_definitions(tenant_id, agent_id, scope, nome, intencao, source, status)
         VALUES ($1, $2, 'agent', 'p84-test-proc', 'test', 'ensino', 'active') RETURNING id`,
        [T, A],
      );
      definition_id = def.rows[0]!.id;
      const pess = await c.query<{ id: string }>(
        `INSERT INTO pessoas(nome, telefone_whatsapp, tipo)
         VALUES ('p84-test', '+5511900000084', 'funcionario') RETURNING id`,
      );
      pessoa_id = pess.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(pessoa_id, escopo_entidades) VALUES ($1, '{}') RETURNING id`,
        [pessoa_id],
      );
      conversa_id = conv.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM procedure_executions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM procedure_definitions WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM conversas WHERE id = $1`, [conversa_id]);
      await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa_id]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    } finally {
      c.release();
      await pool.end();
    }
  });

  it('second insert with same conversa_id no-ops and returns existing row', async () => {
    const { procedureExecutionsRepo } = await import('../../src/db/repositories.js');

    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      const first = await procedureExecutionsRepo.createOrFindActive({
        definition_id,
        definition_version: 1,
        conversa_id,
        status: 'in_progress',
        current_step_id: 'step-1',
        execution_state: {} as any,
        completed_steps: [] as any,
        ended_at: null,
        outcome: null,
        notes: null,
      });
      expect(first.created).toBe(true);

      const second = await procedureExecutionsRepo.createOrFindActive({
        definition_id,
        definition_version: 1,
        conversa_id,
        status: 'in_progress',
        current_step_id: 'step-1',
        execution_state: {} as any,
        completed_steps: [] as any,
        ended_at: null,
        outcome: null,
        notes: null,
      });
      expect(second.created).toBe(false);
      expect(second.execution.id).toBe(first.execution.id);
    });

    const c = await pool.connect();
    try {
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM procedure_executions
         WHERE tenant_id = $1 AND conversa_id = $2 AND status = 'in_progress'`,
        [T, conversa_id],
      );
      expect(r.rows[0]!.count).toBe('1');
      await c.query(`DELETE FROM procedure_executions WHERE tenant_id = $1`, [T]);
    } finally {
      c.release();
    }
  });

  it('null conversa_id is not constrained by the partial index — each call creates a row', async () => {
    const { procedureExecutionsRepo } = await import('../../src/db/repositories.js');

    await runWithTenantContext({ tenant_id: T, agent_id: A }, async () => {
      const a = await procedureExecutionsRepo.createOrFindActive({
        definition_id,
        definition_version: 1,
        conversa_id: null,
        status: 'in_progress',
        current_step_id: null,
        execution_state: {} as any,
        completed_steps: [] as any,
        ended_at: null,
        outcome: null,
        notes: null,
      });
      expect(a.created).toBe(true);

      const b = await procedureExecutionsRepo.createOrFindActive({
        definition_id,
        definition_version: 1,
        conversa_id: null,
        status: 'in_progress',
        current_step_id: null,
        execution_state: {} as any,
        completed_steps: [] as any,
        ended_at: null,
        outcome: null,
        notes: null,
      });
      expect(b.created).toBe(true);
      expect(b.execution.id).not.toBe(a.execution.id);
    });

    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM procedure_executions WHERE tenant_id = $1`, [T]);
    } finally {
      c.release();
    }
  });
});
