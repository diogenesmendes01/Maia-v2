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

/**
 * A saga COMPLETA usa um escopo próprio: o índice parcial
 * `onboarding_runs_one_live_per_agent_uq` só admite uma run viva por
 * (tenant, agente), e a linha whatsapp tem unicidade GLOBAL entre canais
 * ativos (`migrations/091_line_ownership.sql:42`) — o caminho feliz ativa o
 * canal, então ele não pode disputar número com nenhum outro caso.
 */
const E2E_TENANT = 'saga-e2e';
const E2E_AGENT = 'saga-e2e-bot';
const E2E_LINE = '+5511987650001';
const E2E_ACTOR = { actor_id: 'saga-tester', actor_role: 'owner' as const, tenant_id: E2E_TENANT };

const TENANTS = [TENANT, E2E_TENANT];

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
    for (const t of TENANTS) {
      await c.query('DELETE FROM channel_policies WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM channel_line_state WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM channels WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM roles WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM agent_tool_grants WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM agent_operational_profile_versions WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM app_users WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM audit_log WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM agents WHERE tenant_id=$1', [t]);
    }
    // A auditoria da criação/cancelamento de uma run cujo tenant ainda não
    // existia mora no bucket `system` com o alvo em `change_summary`; apagar só
    // por `tenant_id` deixaria lixo (e a FK travaria o DELETE dos tenants).
    await c.query('DELETE FROM admin_audit_log WHERE actor_id=$1', ['saga-tester']);
    for (const t of TENANTS) {
      await c.query('DELETE FROM admin_audit_log WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM tenants WHERE id=$1', [t]);
    }
  } finally {
    c.release();
    await pool.end();
  }
});

let runSeq = 0;

/**
 * `onboarding_runs_one_live_per_tenant_uq` (migration 113) admite UMA run viva
 * sem agente por tenant — a correção do achado 2: duas runs `tenant_onboarding`
 * em `created` para o mesmo tenant provisionavam árvores de governança
 * diferentes. Estes casos são independentes entre si e compartilham o tenant de
 * propósito (cada um observa um aspecto do MESMO provisionamento), então cada
 * um encerra a run do anterior — que é exatamente o que a mensagem de conflito
 * manda um operador fazer ("retome ou cancele").
 */
async function terminateLiveRunsOf(tenant: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `UPDATE onboarding_runs
          SET state='cancelled', cancelled_at=now(), last_error_code='operator_abort',
              failed_step=NULL, resume_state=NULL
        WHERE tenant_id=$1
          AND state NOT IN ('active','cancelled','failed_terminal')`,
      [tenant],
    );
  } finally {
    c.release();
  }
}

async function startRun(): Promise<{ id: string; version: number }> {
  const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
  // A criação é idempotente por chave (migration 113): cada caso precisa da
  // SUA chave, senão o segundo `startRun()` replayaria a run do primeiro.
  await terminateLiveRunsOf(TENANT);
  const out = await startOnboardingRun({
    kind: 'tenant_onboarding',
    tenant_id: TENANT,
    actor: ACTOR,
    idempotency_key: `saga-start-${(runSeq += 1)}-${Date.now()}`,
  });
  if (out.status !== 'started') throw new Error(`startOnboardingRun: ${out.code}`);
  createdRuns.push(out.run.id);
  return { id: out.run.id, version: out.run.version };
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
    await terminateLiveRunsOf(TENANT);
    const created = await onboardingRunsRepo.create({
      kind: 'tenant_onboarding',
      tenant_id: TENANT,
      agent_id: null,
      created_by: 'saga-tester',
      actor_role: 'owner',
      correlation_id: 'exp',
      expires_at: new Date(Date.now() - 1000),
      configuration_contract_version: '1',
      schema_version: 'sf',
      idempotency_key_hash: `saga-exp-${Date.now()}`,
      payload_hash: 'saga-exp-payload',
    });
    if (created.outcome !== 'created') throw new Error(`run não criada: ${created.outcome}`);
    const run = created.run;
    createdRuns.push(run.id);

    expect(await onboardingRunsRepo.expireStale(new Date())).toBeGreaterThanOrEqual(1);
    const after = await onboardingRunsRepo.getForScope({ run_id: run.id, tenant_id: TENANT });
    expect(after?.state).toBe('cancelled');
    expect(after?.last_error_code).toBe('expired');
  });

  it('criar e cancelar uma run cujo tenant AINDA NÃO EXISTE audita sem violar a FK', async () => {
    // Tenant PRÓPRIO e nunca provisionado: `admin_audit_log.tenant_id` é FK
    // para `tenants(id)`, e aqui a linha-alvo não existe nem no fim do teste.
    // Estes são os dois sítios em que o defeito de FK era fatal — a criação da
    // run e o cancelamento de uma run ainda em `created`.
    const { startOnboardingRun, cancelOnboardingRun } = await import(
      '../../src/onboarding/wizard.js'
    );
    const ghost = 'saga-fantasma';
    const actor = { actor_id: 'saga-tester', actor_role: 'owner' as const, tenant_id: ghost };

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: ghost,
      actor,
      idempotency_key: `saga-ghost-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    const view = started.run;
    createdRuns.push(view.id);

    const out = await cancelOnboardingRun({
      run_id: view.id,
      expected_version: view.version,
      actor,
      reason_code: 'operator_abort',
      idempotency_key: `saga-ghost-cancel-${Date.now()}`,
    });
    expect(out.status).toBe('completed');

    const c = await pool.connect();
    try {
      const rows = await c.query(
        `SELECT action, tenant_id, change_summary FROM admin_audit_log
          WHERE resource_id=$1 ORDER BY id`,
        [view.id],
      );
      expect(rows.rows.map((r) => r.action)).toEqual([
        'onboarding_run_started',
        'onboarding_run_cancelled',
      ]);
      for (const row of rows.rows) {
        // A linha existe, mora no bucket, e o alvo continua recuperável.
        expect(row.tenant_id).toBe('system');
        expect(row.change_summary.target_tenant_id).toBe(ghost);
      }
      // E o tenant fantasma continua não existindo — a auditoria não o criou.
      const t = await c.query('SELECT 1 FROM tenants WHERE id=$1', [ghost]);
      expect(t.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });
});

/**
 * O CAMINHO FELIZ INTEIRO, do zero até `active`.
 *
 * Existe porque as suítes anteriores paravam no terceiro passo: um defeito nos
 * passos finais (`declare_channel` escrevia `switch_behavior='fixed'`, fora do
 * CHECK de `channel_policies`) não tinha NENHUM teste que chegasse até ele.
 * Aqui cada um dos onze passos commita contra Postgres de verdade, e o estado
 * final é conferido tabela a tabela.
 */
d('saga de onboarding — caminho feliz completo até a ativação', () => {
  it('provisiona, prova posse da linha, aprova readiness e ativa', async () => {
    const { startOnboardingRun, executeOnboardingStep } = await import(
      '../../src/onboarding/wizard.js'
    );

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: E2E_TENANT,
      actor: E2E_ACTOR,
      idempotency_key: `saga-e2e-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    const view = started.run;
    createdRuns.push(view.id);

    let version = view.version;
    const step = async (
      name: string,
      payload: unknown,
      deps?: Parameters<typeof executeOnboardingStep>[0]['deps'],
    ) => {
      const out = await executeOnboardingStep({
        run_id: view.id,
        step: name,
        payload,
        idempotency_key: `e2e-${name}`,
        expected_version: version,
        actor: E2E_ACTOR,
        ...(deps ? { deps } : {}),
      });
      if (out.status !== 'completed') {
        throw new Error(
          `passo '${name}' não completou: ${JSON.stringify({
            status: out.status,
            ...('code' in out ? { code: out.code, message: out.message } : {}),
          })}`,
        );
      }
      version = out.run.version;
      return out;
    };

    await step('provision_tenant', { tenant_id: E2E_TENANT, nome: 'Saga E2E' });
    await step('provision_admin', {
      user_id: 'saga-e2e-admin',
      email: 'admin@saga-e2e.test',
      role: 'owner',
    });
    await step('provision_agent', { agent_id: E2E_AGENT, nome: 'Bot E2E' });
    await step('configure_profile', { approve: true });
    await step('apply_capability_packs', { granted_packs: [], denied_tools: [] });
    await step('configure_role', {
      role_key: 'atendente',
      display_name: 'Atendente',
      granted_packs: [],
    });

    // `switch_behavior` OMITIDO de propósito: o default do payload é o valor
    // que a UI manda na prática, e era exatamente ele que o CHECK recusava.
    const declared = await step('declare_channel', {
      channel_type: 'whatsapp',
      external_id: E2E_LINE,
      display_name: 'Linha E2E',
    });
    const channel_id = (declared as { result: Record<string, unknown> }).result
      .channel_id as string;
    expect(channel_id).toMatch(/^[0-9a-f-]{36}$/);

    // Pareamento é o único efeito FORA da transação: injetamos a porta de #518.
    const pairingCalls: Array<{ command_id: string; channel_id: string }> = [];
    await step(
      'start_pairing',
      { channel_id, method: 'qr' },
      {
        requestPairing: async (input) => {
          pairingCalls.push({ command_id: input.command_id, channel_id: input.channel_id });
          return { ok: true };
        },
      },
    );
    expect(pairingCalls).toHaveLength(1);
    // `command_id` vai para uma coluna `uuid`: um hash mal formatado seria 22P02.
    expect(pairingCalls[0]!.command_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const c = await pool.connect();
    try {
      // O worker do runtime é quem prova a posse; aqui simulamos o resultado.
      await c.query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
        channel_id,
      ]);
    } finally {
      c.release();
    }

    await step('confirm_channel_ready', { channel_id });

    const readinessOut = await step('evaluate_readiness', {});
    expect(readinessOut.status === 'completed' && readinessOut.readiness?.ready).toBe(true);

    const activated = await step('activate', {
      confirm_tenant_id: E2E_TENANT,
      confirm_agent_id: E2E_AGENT,
    });
    expect(activated.status === 'completed' && activated.run.state).toBe('active');

    const c2 = await pool.connect();
    try {
      const agent = await c2.query('SELECT status FROM agents WHERE id=$1', [E2E_AGENT]);
      expect(agent.rows[0].status).toBe('active');

      const channel = await c2.query('SELECT active FROM channels WHERE id=$1', [channel_id]);
      expect(channel.rows[0].active).toBe(true);

      const policy = await c2.query(
        'SELECT switch_behavior FROM channel_policies WHERE channel_id=$1',
        [channel_id],
      );
      expect(policy.rows[0].switch_behavior).toBe('locked');

      const profile = await c2.query(
        `SELECT version, status FROM agent_operational_profile_versions
          WHERE tenant_id=$1 AND agent_id=$2`,
        [E2E_TENANT, E2E_AGENT],
      );
      expect(profile.rows).toEqual([{ version: 1, status: 'active' }]);

      // A trilha administrativa cobre TODOS os passos que provisionaram algo.
      const audits = await c2.query(
        `SELECT action FROM admin_audit_log
          WHERE change_summary->>'target_tenant_id' = $1 OR tenant_id = $1`,
        [E2E_TENANT],
      );
      expect(audits.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'onboarding_run_started',
          'onboarding_tenant_provisioned',
          'onboarding_admin_provisioned',
          'onboarding_agent_provisioned',
          'onboarding_profile_activated',
          'onboarding_packs_applied',
          'onboarding_role_configured',
          'onboarding_channel_declared',
          'onboarding_pairing_started',
          'onboarding_channel_confirmed',
          'onboarding_readiness_evaluated',
          'onboarding_agent_activated',
        ]),
      );

      // A run terminou: o índice parcial libera um re-onboarding futuro.
      const ledger = await c2.query(
        'SELECT count(*)::int AS n FROM onboarding_step_results WHERE run_id=$1',
        [view.id],
      );
      expect(ledger.rows[0].n).toBe(11);
    } finally {
      c2.release();
    }
  });
});
