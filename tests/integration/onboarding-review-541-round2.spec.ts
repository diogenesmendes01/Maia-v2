/**
 * Issue #519 — a SEGUNDA rodada da review adversarial do PR #541, provada
 * contra Postgres REAL. Cinco achados, cinco propriedades que só o banco
 * demonstra:
 *
 *   1. [High] readiness compõe as precondições de canal POR CANAL, e a
 *      ativação liga exatamente o conjunto validado — o canal governado
 *      inválido continua `active=false` no banco.
 *   2. [High] a criação da run é idempotente por chave, e o índice parcial novo
 *      (`onboarding_runs_one_live_per_tenant_uq`) impede a segunda run viva do
 *      mesmo tenant ANTES de ela ter agente.
 *   3. [Medium] negativas e cancelamento deixam RESULTADO CONCLUSIVO TIPADO em
 *      `onboarding_step_results` — o retry devolve a mesma resposta em vez de
 *      `version_conflict` / `run_terminal`.
 *   4. [Medium] `failed_retryable` guarda o ponto de retomada em colunas reais,
 *      e o backend recusa os passos que rebobinariam a saga.
 *   5. [Medium] `metadata` e `reason_code` são contratos tipados: o texto livre
 *      com PII é recusado na ENTRADA e não existe em nenhuma das três tabelas.
 *
 * Pulado sem `TEST_DB_URL`, como as demais suítes de integração.
 *
 * Cada caso que dirige a saga inteira usa um (tenant, agente, linha) PRÓPRIO:
 * `onboarding_runs_one_live_per_agent_uq` e o índice novo admitem uma única run
 * viva por escopo, e a linha whatsapp tem unicidade global entre canais ativos
 * (`migrations/091_line_ownership.sql`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const ACTOR_ID = 'rev541r2-tester';
const PREFIX = 'rev541r2';

const tenants = new Set<string>();
const createdRuns: string[] = [];
let pool: pg.Pool;

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
    for (const t of tenants) {
      await c.query('DELETE FROM onboarding_events WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM onboarding_step_results WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM onboarding_runs WHERE tenant_id=$1', [t]);
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
    await c.query('DELETE FROM admin_audit_log WHERE actor_id=$1', [ACTOR_ID]);
    for (const t of tenants) {
      await c.query('DELETE FROM admin_audit_log WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM tenants WHERE id=$1', [t]);
    }
  } finally {
    c.release();
    await pool.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Driver da saga — escopo próprio por caso
// ─────────────────────────────────────────────────────────────────────────────

type SagaState = {
  tenant: string;
  agent: string;
  actor: { actor_id: string; actor_role: 'owner'; tenant_id: string };
  run_id: string;
  version: number;
  channel_id: string;
  role_id: string;
  step: (name: string, payload: unknown) => Promise<{ run: { version: number }; result?: unknown }>;
};

/**
 * Leva uma run nova de ZERO até `channel_ready` (ou até `channel_declared`,
 * com `stopAfterDeclare`), num escopo exclusivo.
 */
async function driveToChannelReady(
  suffix: string,
  line: string,
  opts: { stopAfterDeclare?: boolean } = {},
): Promise<SagaState> {
  const { startOnboardingRun, executeOnboardingStep } = await import(
    '../../src/onboarding/wizard.js'
  );
  const tenant = `${PREFIX}-${suffix}`;
  const agent = `${PREFIX}-${suffix}-bot`;
  tenants.add(tenant);
  const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

  const started = await startOnboardingRun({
    kind: 'tenant_onboarding',
    tenant_id: tenant,
    actor,
    idempotency_key: `${PREFIX}-drive-${suffix}-${Date.now()}`,
    metadata: { source: 'cli', intent: 'new_tenant' },
  });
  if (started.status !== 'started') throw new Error(`run não abriu: ${started.code}`);
  const view = started.run;
  createdRuns.push(view.id);

  let version = view.version;
  const step = async (name: string, payload: unknown) => {
    const out = await executeOnboardingStep({
      run_id: view.id,
      step: name,
      payload,
      idempotency_key: `${PREFIX}-${suffix}-${name}`,
      expected_version: version,
      actor,
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
    return out as never;
  };

  await step('provision_tenant', { tenant_id: tenant, nome: `Rev541r2 ${suffix}` });
  await step('provision_admin', {
    user_id: `${PREFIX}-${suffix}-admin`,
    email: `${suffix}@rev541r2.test`,
  });
  await step('provision_agent', { agent_id: agent, nome: `Bot ${suffix}` });
  await step('configure_profile', { approve: true });
  await step('apply_capability_packs', { granted_packs: [], denied_tools: [] });
  await step('configure_role', {
    role_key: 'atendente',
    display_name: 'Atendente',
    granted_packs: [],
  });
  const declared = (await step('declare_channel', {
    channel_type: 'whatsapp',
    external_id: line,
    display_name: `Linha ${suffix}`,
  })) as unknown as { result: Record<string, unknown> };
  const channel_id = declared.result.channel_id as string;

  const c0 = await pool.connect();
  let declaredRole: string;
  try {
    const roles0 = await c0.query(
      'SELECT id FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND is_default=true',
      [tenant, agent],
    );
    declaredRole = roles0.rows[0].id;
  } finally {
    c0.release();
  }

  if (opts.stopAfterDeclare) {
    return {
      tenant,
      agent,
      actor,
      run_id: view.id,
      version,
      channel_id,
      role_id: declaredRole,
      step: step as never,
    };
  }

  await step('start_pairing', { channel_id, method: 'qr' });

  const c = await pool.connect();
  let role_id: string;
  try {
    await c.query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      channel_id,
    ]);
    const roles = await c.query(
      'SELECT id FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND is_default=true',
      [tenant, agent],
    );
    role_id = roles.rows[0].id;
  } finally {
    c.release();
  }

  await step('confirm_channel_ready', { channel_id });
  return {
    tenant,
    agent,
    actor,
    run_id: view.id,
    version,
    channel_id,
    role_id,
    step: step as never,
  };
}

/**
 * Declara uma SEGUNDA linha do MESMO agente, direto no banco: a saga só declara
 * um canal por run, e o cenário do achado 1 exige dois canais governados do
 * mesmo (tenant, agente).
 */
async function addSecondChannel(
  s: SagaState,
  opts: { line: string; role_id: string; line_state: string },
): Promise<string> {
  const c = await pool.connect();
  try {
    const ch = await c.query(
      `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1,$2,'whatsapp',$3,'Segunda linha', false, false) RETURNING id`,
      [s.tenant, s.agent, opts.line],
    );
    const channel_id = ch.rows[0].id as string;
    await c.query(
      `INSERT INTO channel_policies (tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1,$2,$3,$4,'locked')`,
      [s.tenant, s.agent, channel_id, opts.role_id],
    );
    await c.query(
      `INSERT INTO channel_line_state (channel_id, tenant_id, agent_id, state)
       VALUES ($1,$2,$3,$4)`,
      [channel_id, s.tenant, s.agent, opts.line_state],
    );
    return channel_id;
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) [High] a conjunção de canal é POR CANAL — e a ativação usa o conjunto
//     validado, não "todos os que têm política"
// ─────────────────────────────────────────────────────────────────────────────

d('[High] readiness e ativação concordam sobre QUAIS canais são válidos', () => {
  /**
   * O cenário exato da review, montado no banco: dois canais do MESMO agente
   * DIVIDINDO entre si o papel válido e a posse provada.
   *
   *   canal A (o da saga) — política → papel ATIVO, linha `connected`;
   *   canal B (adicionado) — política → papel INATIVO, linha `connected`.
   *
   * Antes, `channel_policy_role_active` passava por A, `channel_ownership_proven`
   * passava por B (ou por A), tudo ficava verde, e `applyActivate` selecionava
   * os canais SÓ pela existência de política: B entrava em roteamento com papel
   * inválido.
   */
  it('o canal governado com papel INATIVO não é ativado — e o veredito diz isso', async () => {
    const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');
    const s = await driveToChannelReady('split', '+5511987651001');

    // Um papel INATIVO para governar o segundo canal.
    const c = await pool.connect();
    let inactiveRole: string;
    try {
      const r = await c.query(
        `INSERT INTO roles (tenant_id, agent_id, role_key, display_name, active, is_default)
         VALUES ($1,$2,'vendas','Vendas', false, false)
         ON CONFLICT (tenant_id, agent_id, role_key) DO UPDATE SET active=false
         RETURNING id`,
        [s.tenant, s.agent],
      );
      inactiveRole = r.rows[0].id;
    } finally {
      c.release();
    }
    const channelB = await addSecondChannel(s, {
      line: '+5511987651002',
      role_id: inactiveRole,
      line_state: 'connected',
    });

    const readiness = await evaluateAgentReadiness({ tenant_id: s.tenant, agent_id: s.agent });
    // O agente continua pronto — existe UM canal integralmente válido.
    expect(readiness.ready).toBe(true);
    // …mas o conjunto ativável exclui B, e a exclusão é explícita.
    expect(readiness.activatable_channel_ids).toEqual([s.channel_id]);
    expect(readiness.channels.find((v) => v.channel_id === channelB)).toMatchObject({
      policy_governed: true,
      policy_role_active: false,
      activatable: false,
    });

    await s.step('evaluate_readiness', {});
    await s.step('activate', { confirm_tenant_id: s.tenant, confirm_agent_id: s.agent });

    const c2 = await pool.connect();
    try {
      const rows = await c2.query(
        'SELECT id, active FROM channels WHERE tenant_id=$1 AND agent_id=$2 ORDER BY created_at',
        [s.tenant, s.agent],
      );
      const byId = new Map(rows.rows.map((r) => [r.id as string, r.active as boolean]));
      // A propriedade: o canal validado roteia, o inválido NÃO.
      expect(byId.get(s.channel_id)).toBe(true);
      expect(byId.get(channelB)).toBe(false);

      const run = await c2.query('SELECT state FROM onboarding_runs WHERE id=$1', [s.run_id]);
      expect(run.rows[0].state).toBe('active');
    } finally {
      c2.release();
    }
  }, 60_000);

  /**
   * O outro lado da mesma moeda: quando NENHUM canal satisfaz a conjunção
   * inteira, o agente não fica pronto — mesmo que os predicados estejam todos
   * "cobertos" pelo conjunto de canais.
   */
  it('dois canais dividindo papel e posse NÃO tornam o agente pronto', async () => {
    const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');
    const s = await driveToChannelReady('nosplit', '+5511987651011');

    const c = await pool.connect();
    let inactiveRole: string;
    try {
      // Canal A perde a posse da linha (volta a `declared`), mantendo o papel
      // ativo; canal B ganha posse com papel inativo.
      await c.query(`UPDATE channel_line_state SET state='declared' WHERE channel_id=$1`, [
        s.channel_id,
      ]);
      const r = await c.query(
        `INSERT INTO roles (tenant_id, agent_id, role_key, display_name, active, is_default)
         VALUES ($1,$2,'vendas','Vendas', false, false)
         ON CONFLICT (tenant_id, agent_id, role_key) DO UPDATE SET active=false
         RETURNING id`,
        [s.tenant, s.agent],
      );
      inactiveRole = r.rows[0].id;
    } finally {
      c.release();
    }
    await addSecondChannel(s, {
      line: '+5511987651012',
      role_id: inactiveRole,
      line_state: 'connected',
    });

    const readiness = await evaluateAgentReadiness({ tenant_id: s.tenant, agent_id: s.agent });
    expect(readiness.ready).toBe(false);
    expect(readiness.activatable_channel_ids).toEqual([]);
    expect(
      readiness.checks.find((k) => k.code === 'channel_ownership_proven')!.status,
    ).toBe('fail');

    // E a ativação recusa, sem escrever nada.
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const evaluated = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: `${PREFIX}-nosplit-eval`,
      expected_version: s.version,
      actor: s.actor,
    });
    expect(evaluated).toMatchObject({ status: 'denied', code: 'readiness_blocked' });

    const c2 = await pool.connect();
    try {
      const agents = await c2.query('SELECT status FROM agents WHERE id=$1 AND tenant_id=$2', [
        s.agent,
        s.tenant,
      ]);
      expect(agents.rows[0].status).toBe('provisioning');
      const active = await c2.query(
        'SELECT count(*)::int AS n FROM channels WHERE tenant_id=$1 AND active=true',
        [s.tenant],
      );
      expect(active.rows[0].n).toBe(0);
    } finally {
      c2.release();
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) [High] criação idempotente + unicidade do escopo inicial
// ─────────────────────────────────────────────────────────────────────────────

d('[High] a criação da run é idempotente e o escopo inicial é único', () => {
  it('o retry da MESMA chave devolve a MESMA run — uma linha, uma trilha', async () => {
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const tenant = `${PREFIX}-idem`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };
    const key = `${PREFIX}-idem-key-${Date.now()}`;

    const first = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: key,
      metadata: { source: 'console' },
    });
    if (first.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(first.run.id);

    const retry = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: key,
      metadata: { source: 'console' },
    });
    expect(retry).toMatchObject({ status: 'started', replayed: true });
    if (retry.status !== 'started') throw new Error('impossível');
    expect(retry.run.id).toBe(first.run.id);

    const c = await pool.connect();
    try {
      const runs = await c.query('SELECT count(*)::int AS n FROM onboarding_runs WHERE tenant_id=$1', [
        tenant,
      ]);
      expect(runs.rows[0].n).toBe(1);
      // Uma única trilha de criação — o retry não duplicou nem evento nem auditoria.
      const events = await c.query(
        `SELECT count(*)::int AS n FROM onboarding_events WHERE run_id=$1 AND event_type='run_created'`,
        [first.run.id],
      );
      expect(events.rows[0].n).toBe(1);
      const audits = await c.query(
        `SELECT count(*)::int AS n FROM admin_audit_log
          WHERE resource_id=$1 AND action='onboarding_run_started'`,
        [first.run.id],
      );
      expect(audits.rows[0].n).toBe(1);
    } finally {
      c.release();
    }
  });

  it('a mesma chave com OUTRA intenção é conflito de payload', async () => {
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const tenant = `${PREFIX}-idem2`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };
    const key = `${PREFIX}-idem2-key-${Date.now()}`;

    const first = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: key,
      metadata: { source: 'console' },
    });
    if (first.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(first.run.id);

    const conflict = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: key,
      metadata: { source: 'automation' },
    });
    expect(conflict).toMatchObject({
      status: 'conflict',
      code: 'idempotency_payload_mismatch',
    });
  });

  /**
   * O buraco do índice: `onboarding_runs_one_live_per_agent_uq` tem predicado
   * `agent_id IS NOT NULL`, e a run passa metade da saga sem agente. O índice
   * novo cobre exatamente esse intervalo.
   */
  it('o BANCO recusa duas runs vivas do mesmo tenant antes de haver agente', async () => {
    const tenant = `${PREFIX}-uniq`;
    tenants.add(tenant);
    const c = await pool.connect();
    try {
      const first = await c.query(
        `INSERT INTO onboarding_runs
           (kind, tenant_id, agent_id, state, created_by, expires_at,
            configuration_contract_version, schema_version)
         VALUES ('tenant_onboarding',$1,NULL,'created','t',now()+interval '1 day','1','sf')
         RETURNING id`,
        [tenant],
      );
      createdRuns.push(first.rows[0].id);

      await expect(
        c.query(
          `INSERT INTO onboarding_runs
             (kind, tenant_id, agent_id, state, created_by, expires_at,
              configuration_contract_version, schema_version)
           VALUES ('tenant_onboarding',$1,NULL,'created','t',now()+interval '1 day','1','sf')`,
          [tenant],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      // E a segunda run passa a ser possível assim que a primeira termina.
      await c.query(`UPDATE onboarding_runs SET state='cancelled' WHERE id=$1`, [
        first.rows[0].id,
      ]);
      const second = await c.query(
        `INSERT INTO onboarding_runs
           (kind, tenant_id, agent_id, state, created_by, expires_at,
            configuration_contract_version, schema_version)
         VALUES ('tenant_onboarding',$1,NULL,'created','t',now()+interval '1 day','1','sf')
         RETURNING id`,
        [tenant],
      );
      createdRuns.push(second.rows[0].id);
    } finally {
      c.release();
    }
  });

  it('uma chave DIFERENTE não abre uma segunda saga viva — o comando recusa', async () => {
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const tenant = `${PREFIX}-uniq2`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

    const first = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-uniq2-a-${Date.now()}`,
    });
    if (first.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(first.run.id);

    const second = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-uniq2-b-${Date.now()}`,
    });
    expect(second).toMatchObject({ status: 'conflict', code: 'duplicate_tenant' });

    const c = await pool.connect();
    try {
      const runs = await c.query('SELECT count(*)::int AS n FROM onboarding_runs WHERE tenant_id=$1', [
        tenant,
      ]);
      expect(runs.rows[0].n).toBe(1);
    } finally {
      c.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3)+(4) [Medium] resultados conclusivos tipados e ponto de retomada
// ─────────────────────────────────────────────────────────────────────────────

d('[Medium] negativa e cancelamento são resultados CONCLUSIVOS no ledger', () => {
  it('a negativa entra no ledger tipada e o retry da mesma chave a replaya', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const s = await driveToChannelReady('deny', '+5511987651021');

    // Derruba o profile ativo: readiness reprova de verdade, lido do banco.
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE agent_operational_profile_versions SET status='proposed'
          WHERE tenant_id=$1 AND agent_id=$2`,
        [s.tenant, s.agent],
      );
    } finally {
      c.release();
    }

    const key = `${PREFIX}-deny-eval`;
    const first = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: key,
      expected_version: s.version,
      actor: s.actor,
    });
    expect(first).toMatchObject({ status: 'denied', code: 'readiness_blocked' });

    const c2 = await pool.connect();
    try {
      const ledger = await c2.query(
        `SELECT outcome_kind, outcome_code, outcome_message FROM onboarding_step_results
          WHERE run_id=$1 AND step='evaluate_readiness'`,
        [s.run_id],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].outcome_kind).toBe('denied');
      expect(ledger.rows[0].outcome_code).toBe('readiness_blocked');
      expect(ledger.rows[0].outcome_message).toBeTruthy();

      const run = await c2.query('SELECT state, version FROM onboarding_runs WHERE id=$1', [
        s.run_id,
      ]);
      expect(run.rows[0].state).toBe('readiness_failed');

      // O retry traz a versão ANTIGA (o cliente nunca viu a nova) e a MESMA
      // chave: antes disso devolvia `version_conflict`.
      const retry = await executeOnboardingStep({
        run_id: s.run_id,
        step: 'evaluate_readiness',
        payload: {},
        idempotency_key: key,
        expected_version: s.version,
        actor: s.actor,
      });
      expect(retry).toMatchObject({ status: 'denied', code: 'readiness_blocked' });

      const after = await c2.query('SELECT version FROM onboarding_runs WHERE id=$1', [s.run_id]);
      expect(after.rows[0].version).toBe(run.rows[0].version); // nenhuma segunda transição
    } finally {
      c2.release();
    }
  }, 60_000);

  it('o cancelamento é replayável — e não vira `run_terminal` no retry', async () => {
    const { startOnboardingRun, cancelOnboardingRun } = await import(
      '../../src/onboarding/wizard.js'
    );
    const tenant = `${PREFIX}-cancel`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-cancel-start-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(started.run.id);

    const key = `${PREFIX}-cancel-key`;
    const first = await cancelOnboardingRun({
      run_id: started.run.id,
      expected_version: started.run.version,
      actor,
      reason_code: 'operator_abort',
      idempotency_key: key,
    });
    expect(first).toMatchObject({ status: 'completed', replayed: false });

    const retry = await cancelOnboardingRun({
      run_id: started.run.id,
      expected_version: started.run.version,
      actor,
      reason_code: 'operator_abort',
      idempotency_key: key,
    });
    expect(retry).toMatchObject({ status: 'completed', replayed: true });

    const c = await pool.connect();
    try {
      const ledger = await c.query(
        `SELECT outcome_kind, outcome_code FROM onboarding_step_results
          WHERE run_id=$1 AND step='cancel_run'`,
        [started.run.id],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].outcome_kind).toBe('cancelled');
      expect(ledger.rows[0].outcome_code).toBe('operator_abort');

      const run = await c.query('SELECT state, version FROM onboarding_runs WHERE id=$1', [
        started.run.id,
      ]);
      expect(run.rows[0].state).toBe('cancelled');
      expect(run.rows[0].version).toBe(started.run.version + 1); // UMA transição
    } finally {
      c.release();
    }
  });
});

d('[Medium] `failed_retryable` guarda o ponto de retomada no BANCO', () => {
  it('uma negativa em `start_pairing` grava o passo e bloqueia os passos que rebobinam', async () => {
    const { startOnboardingRun, executeOnboardingStep } = await import(
      '../../src/onboarding/wizard.js'
    );
    // Para em `channel_declared`: `start_pairing` é legal a partir daí, e é a
    // negativa DELE que a review usa como cenário.
    const s = await driveToChannelReady('retry', '+5511987651031', { stopAfterDeclare: true });

    // Um `start_pairing` que o runtime RECUSA.
    const denied = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'start_pairing',
      payload: { channel_id: s.channel_id, method: 'qr' },
      idempotency_key: `${PREFIX}-retry-deny`,
      expected_version: s.version,
      actor: s.actor,
      deps: { requestPairing: async () => ({ ok: false, reason: 'pairing_rejected' }) },
    });
    expect(denied).toMatchObject({ status: 'denied', code: 'pairing_rejected' });

    const c = await pool.connect();
    try {
      const run = await c.query(
        'SELECT state, failed_step, resume_state, version FROM onboarding_runs WHERE id=$1',
        [s.run_id],
      );
      expect(run.rows[0].state).toBe('failed_retryable');
      expect(run.rows[0].failed_step).toBe('start_pairing');
      expect(run.rows[0].resume_state).toBe('channel_declared');

      const version = run.rows[0].version as number;

      // O passo que REBOBINARIA a saga é recusado pelo backend.
      const rewind = await executeOnboardingStep({
        run_id: s.run_id,
        step: 'declare_channel',
        payload: {
          channel_type: 'whatsapp',
          external_id: '+5511987651032',
          display_name: 'Segunda linha',
        },
        idempotency_key: `${PREFIX}-retry-rewind`,
        expected_version: version,
        actor: s.actor,
      });
      expect(rewind).toMatchObject({ status: 'conflict', code: 'invalid_transition' });

      // NENHUM canal novo foi criado — o passo nem chegou ao `apply`.
      const channels = await c.query(
        'SELECT count(*)::int AS n FROM channels WHERE tenant_id=$1 AND agent_id=$2',
        [s.tenant, s.agent],
      );
      expect(channels.rows[0].n).toBe(1);

      // O retry do PRÓPRIO passo é aceito e limpa o ponto de retomada.
      const retry = await executeOnboardingStep({
        run_id: s.run_id,
        step: 'start_pairing',
        payload: { channel_id: s.channel_id, method: 'qr' },
        idempotency_key: `${PREFIX}-retry-ok`,
        expected_version: version,
        actor: s.actor,
        deps: { requestPairing: async () => ({ ok: true }) },
      });
      expect(retry.status).toBe('completed');

      const after = await c.query(
        'SELECT state, failed_step, resume_state FROM onboarding_runs WHERE id=$1',
        [s.run_id],
      );
      expect(after.rows[0].state).toBe('pairing_pending');
      expect(after.rows[0].failed_step).toBeNull();
      expect(after.rows[0].resume_state).toBeNull();
    } finally {
      c.release();
    }

    // Silencia o lint sobre a variável não usada em alguns caminhos.
    expect(typeof startOnboardingRun).toBe('function');
  }, 60_000);

  it('o BANCO recusa uma run em `failed_retryable` sem ponto de retomada', async () => {
    const tenant = `${PREFIX}-ck`;
    tenants.add(tenant);
    const c = await pool.connect();
    try {
      await expect(
        c.query(
          `INSERT INTO onboarding_runs
             (kind, tenant_id, agent_id, state, created_by, expires_at,
              configuration_contract_version, schema_version)
           VALUES ('tenant_onboarding',$1,NULL,'failed_retryable','t',now()+interval '1 day','1','sf')`,
          [tenant],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      c.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) [Medium] superfícies livres viraram contratos tipados
// ─────────────────────────────────────────────────────────────────────────────

d('[Medium] `metadata` e `reason_code` não aceitam texto livre', () => {
  const PII = 'cliente +5511987654321 / joao@acme.com / token abc123';

  it('metadata com chave livre é recusado — e nada é gravado', async () => {
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const tenant = `${PREFIX}-pii`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

    await expect(
      startOnboardingRun({
        kind: 'tenant_onboarding',
        tenant_id: tenant,
        actor,
        idempotency_key: `${PREFIX}-pii-key-${Date.now()}`,
        metadata: { source: 'console', note: PII } as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_scope' });

    const c = await pool.connect();
    try {
      const runs = await c.query('SELECT count(*)::int AS n FROM onboarding_runs WHERE tenant_id=$1', [
        tenant,
      ]);
      expect(runs.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it('reason_code fora do vocabulário é recusado — e a PII não chega a NENHUMA tabela', async () => {
    const { startOnboardingRun, cancelOnboardingRun } = await import(
      '../../src/onboarding/wizard.js'
    );
    const tenant = `${PREFIX}-pii2`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-pii2-key-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(started.run.id);

    await expect(
      cancelOnboardingRun({
        run_id: started.run.id,
        expected_version: started.run.version,
        actor,
        reason_code: PII as never,
        idempotency_key: `${PREFIX}-pii2-cancel-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_scope' });

    const c = await pool.connect();
    try {
      // A run continua viva: a recusa aconteceu ANTES de qualquer escrita.
      const run = await c.query(
        'SELECT state, last_error_code FROM onboarding_runs WHERE id=$1',
        [started.run.id],
      );
      expect(run.rows[0].state).toBe('created');
      expect(run.rows[0].last_error_code).toBeNull();

      // E o telefone não está em nenhuma das três superfícies persistidas.
      const leaked = await c.query(
        `SELECT
           (SELECT count(*) FROM onboarding_runs WHERE last_error_code LIKE '%5511987654321%') AS runs,
           (SELECT count(*) FROM onboarding_events WHERE summary::text LIKE '%5511987654321%') AS events,
           (SELECT count(*) FROM admin_audit_log WHERE change_summary::text LIKE '%5511987654321%') AS audit`,
      );
      expect(Number(leaked.rows[0].runs)).toBe(0);
      expect(Number(leaked.rows[0].events)).toBe(0);
      expect(Number(leaked.rows[0].audit)).toBe(0);
    } finally {
      c.release();
    }
  });

  it('o metadata APROVADO é persistido projetado, campo a campo', async () => {
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const tenant = `${PREFIX}-meta`;
    tenants.add(tenant);
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-meta-key-${Date.now()}`,
      metadata: { source: 'api', intent: 'reonboarding', ticket_ref: 'OPS-991' },
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    createdRuns.push(started.run.id);

    const c = await pool.connect();
    try {
      const run = await c.query('SELECT metadata FROM onboarding_runs WHERE id=$1', [
        started.run.id,
      ]);
      expect(run.rows[0].metadata).toEqual({
        source: 'api',
        intent: 'reonboarding',
        ticket_ref: 'OPS-991',
      });
    } finally {
      c.release();
    }
  });
});
