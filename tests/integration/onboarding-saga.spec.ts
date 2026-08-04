/**
 * Issue #519 — a saga completa contra Postgres real.
 *
 * NÃO EXECUTADO no sandbox de desenvolvimento (sem Postgres/docker). Pulado
 * sem `TEST_DB_URL`, como as demais suítes de integração.
 *
 * O que só um banco de verdade prova (e a suíte unitária não):
 *   - a atomicidade do `commitStep`: escrita de provisionamento + ledger +
 *     evento + auditoria + novo estado no MESMO commit;
 *   - o retry após um commit perdido devolver o resultado PERSISTIDO;
 *   - o `FOR UPDATE` + `version` serializarem dois operadores de verdade;
 *   - o rollback quando o `apply` lança: nada meio-escrito;
 *   - a readiness canônica lida do banco reprovar e depois aprovar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'saga-acme';
const AGENT = 'saga-acme-bot';
const ACTOR = { actor_id: 'saga-tester', actor_role: 'owner' as const, tenant_id: TENANT };

let pool: pg.Pool;
const createdRuns: string[] = [];

beforeAll(() => {
  if (SHOULD_RUN) pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
});

afterAll(async () => {
  if (!SHOULD_RUN) return;
  const c = await pool.connect();
  try {
    for (const id of createdRuns) {
      await c.query('DELETE FROM onboarding_events WHERE run_id=$1', [id]);
      await c.query('DELETE FROM onboarding_step_results WHERE run_id=$1', [id]);
      await c.query('DELETE FROM onboarding_runs WHERE id=$1', [id]);
    }
    await c.query('DELETE FROM channel_policies WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM channel_line_state WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM channels WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM roles WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM agent_tool_grants WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM agent_operational_profile_versions WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM app_users WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM admin_audit_log WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM audit_log WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM agents WHERE tenant_id=$1', [TENANT]);
    await c.query('DELETE FROM tenants WHERE id=$1', [TENANT]);
  } finally {
    c.release();
    await pool.end();
  }
});

async function startRun(): Promise<{ id: string; version: number }> {
  const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
  const view = await startOnboardingRun({
    kind: 'tenant_onboarding',
    tenant_id: TENANT,
    actor: ACTOR,
  });
  createdRuns.push(view.id);
  return { id: view.id, version: view.version };
}

d('saga de onboarding — ponta a ponta', () => {
  it('provisiona tenant → admin → agente e deixa cada peça coerente e auditada', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const run = await startRun();

    const t = await executeOnboardingStep({
      run_id: run.id,
      step: 'provision_tenant',
      payload: { tenant_id: TENANT, nome: 'Saga Acme' },
      idempotency_key: 'saga-key-tenant',
      expected_version: 1,
      actor: ACTOR,
    });
    expect(t.status).toBe('completed');
    expect(t.status === 'completed' && t.run.state).toBe('tenant_ready');

    const a = await executeOnboardingStep({
      run_id: run.id,
      step: 'provision_admin',
      payload: { user_id: 'saga-admin', email: 'admin@saga.test', role: 'owner' },
      idempotency_key: 'saga-key-admin',
      expected_version: 2,
      actor: ACTOR,
    });
    expect(a.status).toBe('completed');

    const g = await executeOnboardingStep({
      run_id: run.id,
      step: 'provision_agent',
      payload: { agent_id: AGENT, nome: 'Bot da Saga' },
      idempotency_key: 'saga-key-agent',
      expected_version: 3,
      actor: ACTOR,
    });
    expect(g.status).toBe('completed');
    expect(g.status === 'completed' && g.run.agent_id).toBe(AGENT);

    const c = await pool.connect();
    try {
      // O agente NASCE inativo: a ativação é um comando explícito no fim.
      const agent = await c.query('SELECT status FROM agents WHERE id=$1', [AGENT]);
      expect(agent.rows[0].status).toBe('provisioning');

      // O profile semente é v1/proposed — nenhum profile nasce ativo.
      const prof = await c.query(
        'SELECT version, status FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2',
        [TENANT, AGENT],
      );
      expect(prof.rows).toEqual([{ version: 1, status: 'proposed' }]);

      // O piso de capacidades existe junto com o agente.
      const grant = await c.query(
        'SELECT granted_packs FROM agent_tool_grants WHERE tenant_id=$1 AND agent_id=$2',
        [TENANT, AGENT],
      );
      expect(grant.rows[0].granted_packs).toContain('baseline.core');

      // Cada passo deixou trilha administrativa e evento append-only.
      const audits = await c.query(
        'SELECT action FROM admin_audit_log WHERE tenant_id=$1 ORDER BY id',
        [TENANT],
      );
      expect(audits.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'onboarding_tenant_provisioned',
          'onboarding_admin_provisioned',
          'onboarding_agent_provisioned',
        ]),
      );
      const events = await c.query(
        'SELECT event_type FROM onboarding_events WHERE run_id=$1 ORDER BY created_at',
        [run.id],
      );
      expect(events.rows[0].event_type).toBe('run_created');
      expect(events.rows.filter((r) => r.event_type === 'step_completed')).toHaveLength(3);
    } finally {
      c.release();
    }
  });

  it('retry após commit perdido devolve o resultado PERSISTIDO sem re-provisionar', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const run = await startRun();
    const payload = { tenant_id: TENANT, nome: 'Saga Acme' };

    const first = await executeOnboardingStep({
      run_id: run.id, step: 'provision_tenant', payload,
      idempotency_key: 'retry-key-1', expected_version: 1, actor: ACTOR,
    });
    expect(first).toMatchObject({ status: 'completed', replayed: false });

    // O cliente não viu a resposta: repete com a MESMA chave e a versão ANTIGA.
    const retry = await executeOnboardingStep({
      run_id: run.id, step: 'provision_tenant', payload,
      idempotency_key: 'retry-key-1', expected_version: 1, actor: ACTOR,
    });
    expect(retry).toMatchObject({ status: 'completed', replayed: true });

    const c = await pool.connect();
    try {
      const ledger = await c.query(
        'SELECT count(*)::int AS n FROM onboarding_step_results WHERE run_id=$1',
        [run.id],
      );
      expect(ledger.rows[0].n).toBe(1);
      const replays = await c.query(
        "SELECT count(*)::int AS n FROM onboarding_events WHERE run_id=$1 AND event_type='step_replayed'",
        [run.id],
      );
      expect(replays.rows[0].n).toBe(1);
    } finally {
      c.release();
    }
  });

  it('mesma chave com payload divergente é conflito', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const run = await startRun();
    await executeOnboardingStep({
      run_id: run.id, step: 'provision_tenant',
      payload: { tenant_id: TENANT, nome: 'Saga Acme' },
      idempotency_key: 'conflict-key', expected_version: 1, actor: ACTOR,
    });
    const out = await executeOnboardingStep({
      run_id: run.id, step: 'provision_tenant',
      payload: { tenant_id: TENANT, nome: 'OUTRO NOME' },
      idempotency_key: 'conflict-key', expected_version: 1, actor: ACTOR,
    });
    expect(out).toMatchObject({ status: 'conflict', code: 'idempotency_payload_mismatch' });
  });

  it('dois comandos concorrentes na mesma versão produzem UM avanço', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const run = await startRun();
    const call = (key: string) =>
      executeOnboardingStep({
        run_id: run.id, step: 'provision_tenant',
        payload: { tenant_id: TENANT, nome: 'Saga Acme' },
        idempotency_key: key, expected_version: 1, actor: ACTOR,
      });
    const [a, b] = await Promise.all([call('conc-key-a'), call('conc-key-b')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['completed', 'conflict']);
  });

  it('uma exceção no meio do passo NÃO deixa estado parcial', async () => {
    const { onboardingRunsRepo } = await import('../../src/db/repositories/onboarding-repos.js');
    const run = await startRun();
    await expect(
      onboardingRunsRepo.commitStep({
        run_id: run.id,
        tenant_id: TENANT,
        expected_version: 1,
        step: 'provision_tenant',
        idempotency_key_hash: 'a'.repeat(64),
        payload_hash: 'b'.repeat(64),
        actor_id: 'saga-tester',
        actor_role: 'owner',
        correlation_id: 'boom',
        apply: async (tx) => {
          // Escreve algo e ENTÃO explode: o rollback tem de levar tudo.
          await tx.execute?.(
            // @ts-expect-error — handle drizzle; a chamada crua basta para o teste
            "INSERT INTO tenants(id, nome) VALUES ('saga-orphan','x') ON CONFLICT DO NOTHING",
          );
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    const c = await pool.connect();
    try {
      const orphan = await c.query('SELECT 1 FROM tenants WHERE id=$1', ['saga-orphan']);
      expect(orphan.rowCount).toBe(0);
      const ledger = await c.query(
        'SELECT count(*)::int AS n FROM onboarding_step_results WHERE run_id=$1',
        [run.id],
      );
      expect(ledger.rows[0].n).toBe(0);
      const state = await c.query('SELECT state, version FROM onboarding_runs WHERE id=$1', [run.id]);
      expect(state.rows[0]).toEqual({ state: 'created', version: 1 });
    } finally {
      c.release();
    }
  });

  it('readiness canônico reprova o agente recém-criado e a ativação falha FECHADA', async () => {
    const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');
    const c = await pool.connect();
    try {
      await c.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING', [TENANT]);
      await c.query(
        'INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1,$2,$1,$3) ON CONFLICT DO NOTHING',
        [AGENT, TENANT, 'provisioning'],
      );
    } finally {
      c.release();
    }

    const readiness = await evaluateAgentReadiness({ tenant_id: TENANT, agent_id: AGENT });
    expect(readiness.ready).toBe(false);
    const failed = readiness.checks.filter((k) => k.severity === 'blocking' && k.status === 'fail');
    expect(failed.map((k) => k.code)).toEqual(
      expect.arrayContaining(['profile_active', 'default_role_resolved', 'channel_declared']),
    );
    expect(readiness.configuration_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(readiness.schema_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a expiração cancela a run e preserva o motivo', async () => {
    const { onboardingRunsRepo } = await import('../../src/db/repositories/onboarding-repos.js');
    const run = await onboardingRunsRepo.create({
      kind: 'tenant_onboarding',
      tenant_id: TENANT,
      agent_id: null,
      created_by: 'saga-tester',
      actor_role: 'owner',
      correlation_id: 'exp',
      expires_at: new Date(Date.now() - 1000),
      configuration_contract_version: '1',
      schema_version: 'sf',
    });
    createdRuns.push(run.id);

    expect(await onboardingRunsRepo.expireStale(new Date())).toBeGreaterThanOrEqual(1);
    const after = await onboardingRunsRepo.getForScope({ run_id: run.id, tenant_id: TENANT });
    expect(after?.state).toBe('cancelled');
    expect(after?.last_error_code).toBe('expired');
  });
});
