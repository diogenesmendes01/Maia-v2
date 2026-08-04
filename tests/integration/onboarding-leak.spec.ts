/**
 * Issue #519 — leak suite da saga de onboarding.
 *
 * Cobre os cinco verbos que a issue exige ("leak tests cobrem leitura,
 * escrita, retomada, cancelamento e ativação") contra as três tabelas novas.
 *
 * NÃO EXECUTADO no sandbox de desenvolvimento (sem Postgres). Pulado sem
 * `TEST_DB_URL`, exatamente como `agent-tool-grants-leak.spec.ts`.
 *
 * NOTA para quem mantiver `package.json`: este arquivo PRECISA entrar no
 * script `test:leak`. Ele não foi adicionado aqui porque `package.json` estava
 * fora do escopo de edição desta entrega.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const dRaw = process.env.TEST_DB_URL ? describe : describe.skip;
const dRepo = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

const T_A = 'leak-onb-a';
const T_B = 'leak-onb-b';
const AG_A = 'leak-onb-a-bot';
const AG_B = 'leak-onb-b-bot';

async function ensureScope(c: pg.PoolClient, tenant: string, agent: string): Promise<void> {
  await c.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [tenant]);
  await c.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

async function insertRun(c: pg.PoolClient, tenant: string, agent: string): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO onboarding_runs
       (kind, tenant_id, agent_id, state, created_by, expires_at,
        configuration_contract_version, schema_version)
     VALUES ('tenant_onboarding', $1, $2, 'agent_draft', 'tester', now() + interval '1 day', '1', 'sf')
     RETURNING id`,
    [tenant, agent],
  );
  return res.rows[0]!.id;
}

beforeAll(() => {
  if (process.env.TEST_DB_URL) pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
});
afterAll(async () => {
  await pool?.end();
});

dRaw('onboarding — isolamento no SQL cru', () => {
  it('uma consulta escopada nunca devolve a run de outro tenant', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureScope(c, T_A, AG_A);
      await ensureScope(c, T_B, AG_B);
      const runA = await insertRun(c, T_A, AG_A);
      const runB = await insertRun(c, T_B, AG_B);

      // LEITURA: o predicado do repo (`id` + `tenant_id`).
      const seen = await c.query('SELECT id FROM onboarding_runs WHERE id=$1 AND tenant_id=$2', [
        runB,
        T_A,
      ]);
      expect(seen.rowCount).toBe(0);

      // ESCRITA / RETOMADA: o UPDATE do `commitStep` carrega o mesmo par.
      const moved = await c.query(
        `UPDATE onboarding_runs SET state='profile_ready', version=version+1
          WHERE id=$1 AND tenant_id=$2 AND version=1`,
        [runB, T_A],
      );
      expect(moved.rowCount).toBe(0);

      // CANCELAMENTO.
      const cancelled = await c.query(
        `UPDATE onboarding_runs SET state='cancelled' WHERE id=$1 AND tenant_id=$2`,
        [runA, T_B],
      );
      expect(cancelled.rowCount).toBe(0);

      // ATIVAÇÃO: a mesma forma de UPDATE.
      const activated = await c.query(
        `UPDATE onboarding_runs SET state='active' WHERE id=$1 AND tenant_id=$2`,
        [runB, T_A],
      );
      expect(activated.rowCount).toBe(0);

      // A run do PRÓPRIO tenant continua alcançável (o teste não passa por vacuidade).
      const own = await c.query('SELECT id FROM onboarding_runs WHERE id=$1 AND tenant_id=$2', [
        runA,
        T_A,
      ]);
      expect(own.rowCount).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('o CHECK do schema recusa os literais reservados', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const literal of ['default', 'system']) {
        await expect(
          c.query(
            `INSERT INTO onboarding_runs
               (kind, tenant_id, state, created_by, expires_at,
                configuration_contract_version, schema_version)
             VALUES ('tenant_onboarding', $1, 'created', 't', now() + interval '1 day', '1', 'sf')`,
            [literal],
          ),
        ).rejects.toThrow();
        await c.query('ROLLBACK');
        await c.query('BEGIN');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('no máximo UMA run viva por (tenant, agente)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureScope(c, T_A, AG_A);
      await insertRun(c, T_A, AG_A);
      await expect(insertRun(c, T_A, AG_A)).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('o unique do ledger de idempotência é por (run, passo, hash da chave)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureScope(c, T_A, AG_A);
      const run = await insertRun(c, T_A, AG_A);
      const ins = (hash: string) =>
        c.query(
          `INSERT INTO onboarding_step_results (run_id, tenant_id, step, idempotency_key_hash, payload_hash)
           VALUES ($1,$2,'configure_profile',$3,'ph')`,
          [run, T_A, hash],
        );
      await ins('h1');
      await ins('h2'); // chave diferente ⇒ ok no schema (a máquina de estados barra)
      await expect(ins('h1')).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('eventos são protegidos contra DELETE em cascata da run', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await ensureScope(c, T_A, AG_A);
      const run = await insertRun(c, T_A, AG_A);
      await c.query(
        `INSERT INTO onboarding_events (run_id, tenant_id, agent_id, step, event_type, actor_id)
         VALUES ($1,$2,$3,'provision_agent','step_completed','tester')`,
        [run, T_A, AG_A],
      );
      // ON DELETE RESTRICT: apagar a run com histórico é impossível.
      await expect(c.query('DELETE FROM onboarding_runs WHERE id=$1', [run])).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

dRepo('onboarding — isolamento pelo repo', () => {
  const created: string[] = [];

  afterAll(async () => {
    const c = await pool.connect();
    try {
      for (const id of created) {
        await c.query('DELETE FROM onboarding_events WHERE run_id=$1', [id]);
        await c.query('DELETE FROM onboarding_step_results WHERE run_id=$1', [id]);
        await c.query('DELETE FROM onboarding_runs WHERE id=$1', [id]);
      }
      await c.query('DELETE FROM admin_audit_log WHERE actor_id=$1', ['leak-tester']);
      for (const a of [AG_A, AG_B]) await c.query('DELETE FROM agents WHERE id=$1', [a]);
      for (const t of [T_A, T_B]) await c.query('DELETE FROM tenants WHERE id=$1', [t]);
    } finally {
      c.release();
    }
  });

  it('getForScope de outro tenant devolve null; commitStep devolve not_found', async () => {
    const { onboardingRunsRepo } = await import('../../src/db/repositories/onboarding-repos.js');
    const c = await pool.connect();
    try {
      await ensureScope(c, T_A, AG_A);
      await ensureScope(c, T_B, AG_B);
    } finally {
      c.release();
    }

    const run = await onboardingRunsRepo.create({
      kind: 'tenant_onboarding',
      tenant_id: T_A,
      agent_id: null,
      created_by: 'leak-tester',
      actor_role: 'owner',
      correlation_id: 'leak-corr',
      expires_at: new Date(Date.now() + 3_600_000),
      configuration_contract_version: '1',
      schema_version: 'sf',
    });
    created.push(run.id);

    expect(await onboardingRunsRepo.getForScope({ run_id: run.id, tenant_id: T_B })).toBeNull();
    expect(await onboardingRunsRepo.getForScope({ run_id: run.id, tenant_id: T_A })).not.toBeNull();

    let applied = false;
    const outcome = await onboardingRunsRepo.commitStep({
      run_id: run.id,
      tenant_id: T_B,
      expected_version: 1,
      step: 'provision_tenant',
      idempotency_key_hash: 'x'.repeat(64),
      payload_hash: 'y'.repeat(64),
      actor_id: 'leak-tester',
      actor_role: 'owner',
      correlation_id: 'leak-corr',
      apply: async () => {
        applied = true;
        throw new Error('não deveria chegar aqui');
      },
    });
    expect(outcome.outcome).toBe('not_found');
    expect(applied).toBe(false);

    // Cancelamento cross-tenant também não alcança.
    const cancel = await onboardingRunsRepo.cancel({
      run_id: run.id,
      tenant_id: T_B,
      expected_version: 1,
      actor_id: 'leak-tester',
      actor_role: 'owner',
      correlation_id: 'leak-corr',
      reason_code: 'test',
    });
    expect(cancel.outcome).toBe('not_found');

    // A listagem do tenant B não enxerga a run do tenant A.
    const listB = await onboardingRunsRepo.listForTenant({ tenant_id: T_B });
    expect(listB.map((r) => r.id)).not.toContain(run.id);

    // O histórico também é escopado.
    expect(await onboardingRunsRepo.listEvents({ run_id: run.id, tenant_id: T_B })).toEqual([]);
    expect(
      (await onboardingRunsRepo.listEvents({ run_id: run.id, tenant_id: T_A })).length,
    ).toBeGreaterThan(0);
  });
});
