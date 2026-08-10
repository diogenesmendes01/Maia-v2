/**
 * Issue #519 — as correções da review do PR #541, provadas contra Postgres
 * REAL. Nenhuma delas é demonstrável com store falso: são sobre o que o BANCO
 * enxerga — o estado do ledger de migrations, o predicado de escopo, e o
 * isolamento entre transações concorrentes de verdade.
 *
 * Pulado sem `TEST_DB_URL`, como as demais suítes de integração.
 *
 *   1. [High] `schema_ready` consome o veredito canônico de `src/migrations/`:
 *      uma linha `dirty` ou um checksum divergente REPROVAM, mesmo com ZERO
 *      pendentes — e o `schema_fingerprint` muda com eles.
 *   2. [High] a leitura de `agents` carrega `tenant_id + agent_id`: agente de
 *      outro tenant é indistinguível de ausência, em readiness E em
 *      `applyProvisionAgent`.
 *   3. [High] o retrato de readiness da ativação é ATÔMICO: um `DELETE`
 *      concorrente de política BLOQUEIA na janela entre a decisão e a escrita,
 *      e `applyActivate` ainda confere o efeito antes de a run concluir.
 *   4. [High] o pareamento é enfileirado DENTRO da transação do passo: um
 *      pedido que o commit recusa não deixa comando na fila de #518.
 *   5. [Medium] métricas pela camada sanitizada — coberto sem banco em
 *      `tests/unit/onboarding/metrics-taxonomy.spec.ts`.
 *
 * Cada caso que dirige a saga inteira usa um (tenant, agente, linha) PRÓPRIO:
 * `onboarding_runs_one_live_per_agent_uq` admite uma única run viva por par, e
 * a linha whatsapp tem unicidade global entre canais ativos
 * (`migrations/091_line_ownership.sql`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { useExclusivePairingQueue } from './helpers/pairing-queue-lock.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// A fila de `channel_line_state` é global por desenho — ver o helper.
useExclusivePairingQueue();

const ACTOR_ID = 'rev541-tester';
/** Tenant vizinho: é dele o agente cuja existência NÃO pode vazar. */
const T_OTHER = 'rev541-globex';
const A_OTHER = 'rev541-globex-bot';

const tenants = new Set<string>([T_OTHER]);
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
// (1) schema_ready — o veredito canônico, não a contagem de linhas do ledger
// ─────────────────────────────────────────────────────────────────────────────

d('[High] schema_ready consome `getSchemaReadiness`, nunca `schema_migrations` cru', () => {
  it('o banco migrado é `ready` e a evidência por migration traz estado + checksum', async () => {
    const { loadSchemaState } = await import('../../src/onboarding/readiness-facts.js');
    const { schemaFingerprint } = await import('../../src/onboarding/readiness.js');

    const schema = await loadSchemaState();
    expect(schema.state).toBe('ready');
    expect(schema.ready).toBe(true);
    expect(schema.blockers).toEqual([]);
    // A evidência POR MIGRATION é o insumo da fingerprint. Sem ela, a
    // fingerprint seria só a lista de ids — igual num schema sujo.
    expect(schema.verified.length).toBeGreaterThan(100);
    expect(schema.verified.every((e) => e.state === 'applied')).toBe(true);
    expect(schema.verified.every((e) => /^[0-9a-f]{64}$/.test(e.checksum ?? ''))).toBe(true);
    expect(schemaFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * O DEFEITO EXATO da review, reproduzido no banco: uma migration marcada
   * `dirty` (uma no-transaction que morreu no meio) NÃO é pendente. O código
   * antigo lia `SELECT id FROM schema_migrations` e tratava a linha como
   * aplicada, então `pending_migrations` continuava vazio e `schema_ready`
   * ficava VERDE — no exato instante em que uma ativação o consulta.
   */
  it('uma migration `dirty` REPROVA — mesmo com zero pendentes — e muda a fingerprint', async () => {
    const { loadSchemaState } = await import('../../src/onboarding/readiness-facts.js');
    const { evaluateReadinessFacts, schemaFingerprint } = await import(
      '../../src/onboarding/readiness.js'
    );

    const healthy = await loadSchemaState();
    const healthyFp = schemaFingerprint(healthy);
    const victim = healthy.applied_migrations.at(-1)!;

    const c = await pool.connect();
    try {
      await c.query(`UPDATE schema_migrations SET status='dirty' WHERE id=$1`, [victim]);
      const dirty = await loadSchemaState();

      // A CONTAGEM ANTIGA continua dizendo "nada pendente" — é exatamente por
      // isso que ela não servia como veredito.
      expect(dirty.pending_migrations).toEqual([]);

      expect(dirty.ready).toBe(false);
      expect(dirty.state).toBe('blocked');
      expect(dirty.blockers.map((b) => b.kind)).toContain('dirty_migration');
      // A fingerprint muda; hasheando só ids ela era IDÊNTICA.
      expect(schemaFingerprint(dirty)).not.toBe(healthyFp);

      const check = evaluateReadinessFacts({
        requested: { tenant_id: 'rev541-x', agent_id: 'rev541-x-bot' },
        tenant: { id: 'rev541-x', status: 'active' },
        agent: { id: 'rev541-x-bot', tenant_id: 'rev541-x', status: 'active' },
        profile: null,
        tool_grant: null,
        roles: [],
        channels: [],
        policies: [],
        required_packs: [],
        schema: dirty,
        blocking_governance_items: 0,
      }).checks.find((k) => k.code === 'schema_ready')!;
      expect(check.status).toBe('fail');
      expect(check.severity).toBe('blocking');
      expect(check.message).toContain('dirty_migration');
      // A mensagem é persistida: nunca SQL, DSN ou texto de driver.
      expect(check.message).not.toMatch(/postgres:\/\/|password|SELECT /i);
    } finally {
      await c.query(`UPDATE schema_migrations SET status='applied' WHERE id=$1`, [victim]);
      c.release();
    }

    const restored = await loadSchemaState();
    expect(restored.ready).toBe(true);
    expect(schemaFingerprint(restored)).toBe(healthyFp);
  });

  it('um checksum divergente REPROVA — a migration aplicada foi editada', async () => {
    const { loadSchemaState } = await import('../../src/onboarding/readiness-facts.js');
    const healthy = await loadSchemaState();
    const victim = healthy.applied_migrations.at(-1)!;
    const original = healthy.verified.find((e) => e.id === victim)!.checksum;

    const c = await pool.connect();
    try {
      await c.query(`UPDATE schema_migrations SET checksum_sha256=$2 WHERE id=$1`, [
        victim,
        'f'.repeat(64),
      ]);
      const drifted = await loadSchemaState();
      expect(drifted.pending_migrations).toEqual([]);
      expect(drifted.ready).toBe(false);
      expect(drifted.blockers.map((b) => b.kind)).toContain('checksum_mismatch');
    } finally {
      await c.query(`UPDATE schema_migrations SET checksum_sha256=$2 WHERE id=$1`, [
        victim,
        original,
      ]);
      c.release();
    }
    expect((await loadSchemaState()).ready).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) tenant_id + agent_id na leitura de `agents`
// ─────────────────────────────────────────────────────────────────────────────

d('[High] a leitura de `agents` não vaza existência entre tenants', () => {
  const T = 'rev541-scope';
  tenants.add(T);

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      for (const t of [T, T_OTHER]) {
        await c.query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING', [t]);
      }
      // O agente EXISTE — só que no tenant vizinho.
      await c.query(
        'INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1,$2,$1,$3) ON CONFLICT DO NOTHING',
        [A_OTHER, T_OTHER, 'active'],
      );
    } finally {
      c.release();
    }
  });

  it('agente de OUTRO tenant é indistinguível de agente inexistente', async () => {
    const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');

    const project = (r: Awaited<ReturnType<typeof evaluateAgentReadiness>>) =>
      r.checks
        .filter((k) => k.code === 'agent_exists' || k.code === 'agent_belongs_to_tenant')
        .map((k) => ({ code: k.code, status: k.status, message: k.message }));

    const foreign = await evaluateAgentReadiness({ tenant_id: T, agent_id: A_OTHER });
    const absent = await evaluateAgentReadiness({ tenant_id: T, agent_id: 'rev541-nao-existe' });

    expect(foreign.ready).toBe(false);
    expect(absent.ready).toBe(false);
    // Byte a byte iguais: NENHUMA resposta do readiness distingue os dois casos.
    expect(project(foreign)).toEqual(project(absent));
    expect(project(foreign).every((k) => k.status === 'fail')).toBe(true);
    // E o `configuration_fingerprint` também não carrega nada do agente alheio.
    expect(foreign.configuration_fingerprint).toBe(absent.configuration_fingerprint);
  });

  it('`applyProvisionAgent` recusa um id já em uso sem revelar o dono', async () => {
    const { onboardingRunsRepo } = await import('../../src/db/repositories/onboarding-repos.js');
    const { startOnboardingRun } = await import('../../src/onboarding/wizard.js');
    const { applyProvisionAgent } = await import('../../src/onboarding/provisioning.js');

    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: T };
    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: T,
      actor,
      idempotency_key: `rev541-agent-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error('run não abriu');
    const view = started.run;
    createdRuns.push(view.id);

    const c = await pool.connect();
    try {
      await c.query(`UPDATE onboarding_runs SET state='admin_ready', version=3 WHERE id=$1`, [
        view.id,
      ]);
    } finally {
      c.release();
    }

    let thrown: unknown;
    await expect(
      onboardingRunsRepo.commitStep({
        run_id: view.id,
        tenant_id: T,
        expected_version: 3,
        step: 'provision_agent',
        idempotency_key_hash: 'c'.repeat(64),
        payload_hash: 'd'.repeat(64),
        actor_id: ACTOR_ID,
        actor_role: 'owner',
        correlation_id: 'rev541-dup',
        // O id pertence ao tenant VIZINHO.
        apply: (tx, run) =>
          applyProvisionAgent(tx, run, { agent_id: A_OTHER, nome: 'Roubo' }).catch((e) => {
            thrown = e;
            throw e;
          }),
      }),
    ).rejects.toThrow();

    expect((thrown as { code?: string }).code).toBe('duplicate_agent');
    // A mensagem NÃO nomeia o dono nem confirma "pertence a outro tenant".
    const msg = String((thrown as Error).message);
    expect(msg).not.toContain(T_OTHER);
    expect(msg).not.toMatch(/outro tenant/i);

    // O agente do vizinho continua intacto, no tenant dele.
    const c2 = await pool.connect();
    try {
      const row = await c2.query('SELECT tenant_id FROM agents WHERE id=$1', [A_OTHER]);
      expect(row.rows[0].tenant_id).toBe(T_OTHER);
    } finally {
      c2.release();
    }
  });

  it('o diagnóstico GLOBAL existe, mas só para `founder` e deixa trilha', async () => {
    const { diagnoseAgentOwnershipGlobally } = await import(
      '../../src/onboarding/readiness-facts.js'
    );

    await expect(
      diagnoseAgentOwnershipGlobally({
        scope: { tenant_id: T, agent_id: A_OTHER },
        actor: { actor_id: ACTOR_ID, actor_role: 'owner' },
        reason_code: 'tentativa',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const verdict = await diagnoseAgentOwnershipGlobally({
      scope: { tenant_id: T, agent_id: A_OTHER },
      actor: { actor_id: ACTOR_ID, actor_role: 'founder' },
      reason_code: 'suporte',
    });
    expect(verdict).toEqual({ verdict: 'owned_by_other_tenant', owner_tenant_id: T_OTHER });

    const c = await pool.connect();
    try {
      const rows = await c.query(
        `SELECT tenant_id, change_summary FROM admin_audit_log
          WHERE action='onboarding_agent_ownership_diagnosed' AND actor_id=$1`,
        [ACTOR_ID],
      );
      // Exatamente UMA linha: a consulta recusada não audita (nada aconteceu).
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].tenant_id).toBe('system');
      expect(rows.rows[0].change_summary.verdict).toBe('owned_by_other_tenant');
      expect(rows.rows[0].change_summary.target_agent_id).toBe(A_OTHER);
    } finally {
      c.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Driver da saga — escopo próprio por caso
// ─────────────────────────────────────────────────────────────────────────────

type SagaState = {
  tenant: string;
  agent: string;
  run_id: string;
  version: number;
  channel_id: string;
  command_id: string;
};

/** Leva uma run nova de ZERO até `channel_ready`, num escopo exclusivo. */
async function driveToChannelReady(suffix: string, line: string): Promise<SagaState> {
  const { startOnboardingRun, executeOnboardingStep } = await import(
    '../../src/onboarding/wizard.js'
  );
  const tenant = `rev541-${suffix}`;
  const agent = `rev541-${suffix}-bot`;
  tenants.add(tenant);
  const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

  const started = await startOnboardingRun({
    kind: 'tenant_onboarding',
    tenant_id: tenant,
    actor,
    idempotency_key: `rev541-drive-${tenant}-${Date.now()}`,
  });
  if (started.status !== 'started') throw new Error('run não abriu');
  const view = started.run;
  createdRuns.push(view.id);

  let version = view.version;
  const step = async (name: string, payload: unknown) => {
    const out = await executeOnboardingStep({
      run_id: view.id,
      step: name,
      payload,
      idempotency_key: `rev541-${suffix}-${name}`,
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
    return out;
  };

  await step('provision_tenant', { tenant_id: tenant, nome: `Rev541 ${suffix}` });
  await step('provision_admin', { user_id: `rev541-${suffix}-admin`, email: `${suffix}@rev541.test` });
  await step('provision_agent', { agent_id: agent, nome: `Bot ${suffix}` });
  await step('configure_profile', { approve: true });
  await step('apply_capability_packs', { granted_packs: [], denied_tools: [] });
  await step('configure_role', {
    role_key: 'atendente',
    display_name: 'Atendente',
    granted_packs: [],
  });
  const declared = await step('declare_channel', {
    channel_type: 'whatsapp',
    external_id: line,
    display_name: `Linha ${suffix}`,
  });
  const channel_id = (declared as { result: Record<string, unknown> }).result.channel_id as string;

  // SEM porta injetada: o pareamento real enfileira na fila de #518, dentro da
  // transação do passo.
  await step('start_pairing', { channel_id, method: 'qr' });

  const c = await pool.connect();
  let command_id: string;
  try {
    const line_row = await c.query(
      'SELECT command, command_id, state FROM channel_line_state WHERE channel_id=$1',
      [channel_id],
    );
    expect(line_row.rows[0].command).toBe('start_pairing');
    command_id = line_row.rows[0].command_id;
    // O worker do runtime é quem prova a posse; aqui simulamos o resultado.
    await c.query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      channel_id,
    ]);
  } finally {
    c.release();
  }

  await step('confirm_channel_ready', { channel_id });
  return { tenant, agent, run_id: view.id, version, channel_id, command_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) pareamento dentro da transação
// ─────────────────────────────────────────────────────────────────────────────

d('[High] o pareamento entra na TRANSAÇÃO do passo, nunca antes dela', () => {
  it('o comando fica na fila de #518 e a auditoria cai no MESMO commit', async () => {
    const s = await driveToChannelReady('pair', '+5511987650041');
    expect(s.command_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const c = await pool.connect();
    try {
      const audits = await c.query(
        `SELECT action FROM admin_audit_log WHERE resource_id=$1 ORDER BY id`,
        [s.channel_id],
      );
      const actions = audits.rows.map((r) => r.action);
      // A trilha do enfileiramento (#518) e a do passo da saga (#519) foram
      // gravadas juntas — antes eram duas transações independentes.
      expect(actions).toContain('onboarding_pairing_requested');
      expect(actions).toContain('onboarding_pairing_started');
    } finally {
      c.release();
    }
  });

  /**
   * O defeito: a porta era chamada ANTES de `commitStep` travar a run e
   * conferir expiração/ledger/versão/transição. Um pedido com versão velha
   * enfileirava o comando e SÓ ENTÃO recebia `version_conflict` — efeito de
   * runtime para um comando que o backend recusou.
   */
  it.each([
    [
      'versão velha ⇒ version_conflict',
      'stale',
      '+5511987650042',
      (_s: SagaState) => ({ version: 1, expect_code: 'version_conflict' }),
      null,
    ],
    [
      'run expirada ⇒ run_expired',
      'expired',
      '+5511987650043',
      (s: SagaState) => ({ version: s.version, expect_code: 'run_expired' }),
      `UPDATE onboarding_runs SET expires_at = now() - interval '1 hour' WHERE id=$1`,
    ],
    [
      'run cancelada ⇒ run_terminal',
      'cancelled',
      '+5511987650044',
      (s: SagaState) => ({ version: s.version, expect_code: 'run_terminal' }),
      `UPDATE onboarding_runs SET state='cancelled' WHERE id=$1`,
    ],
  ])(
    'um `start_pairing` recusado pelo commit (%s) NÃO deixa comando na fila',
    async (_label, suffix, line, plan, sabotage) => {
      const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
      const s = await driveToChannelReady(suffix, line);
      const { version, expect_code } = plan(s);

      const c = await pool.connect();
      try {
        // Zera a fila: o worker de #518 teria consumido o comando anterior.
        await c.query(
          `UPDATE channel_line_state SET command=NULL, command_id=NULL WHERE channel_id=$1`,
          [s.channel_id],
        );
        if (sabotage) await c.query(sabotage, [s.run_id]);
        const before = await c.query(
          'SELECT command FROM channel_line_state WHERE channel_id=$1',
          [s.channel_id],
        );
        expect(before.rows[0].command).toBeNull();
      } finally {
        c.release();
      }

      const out = await executeOnboardingStep({
        run_id: s.run_id,
        step: 'start_pairing',
        payload: { channel_id: s.channel_id, method: 'qr' },
        idempotency_key: `rev541-${suffix}-rejeitado`,
        expected_version: version,
        actor: { actor_id: ACTOR_ID, actor_role: 'owner', tenant_id: s.tenant },
      });
      expect(out).toMatchObject({ status: 'conflict', code: expect_code });

      const c2 = await pool.connect();
      try {
        const after = await c2.query(
          'SELECT command, command_id FROM channel_line_state WHERE channel_id=$1',
          [s.channel_id],
        );
        // ESTA é a asserção que falhava antes da correção: o comando estava lá.
        expect(after.rows[0].command).toBeNull();
        expect(after.rows[0].command_id).toBeNull();
      } finally {
        c2.release();
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) atomicidade do retrato de readiness
// ─────────────────────────────────────────────────────────────────────────────

d('[High] o retrato de readiness da ativação é atômico', () => {
  it('um DELETE concorrente de política BLOQUEIA na janela — e a ativação conclui íntegra', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const s = await driveToChannelReady('atomic', '+5511987650045');
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: s.tenant };

    const evaluated = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: 'saga-key-atomic-ready',
      expected_version: s.version,
      actor,
    });
    expect(evaluated.status).toBe('completed');
    expect(evaluated.status === 'completed' && evaluated.readiness?.ready).toBe(true);
    const version = evaluated.status === 'completed' ? evaluated.run.version : 0;

    // O RACER: outra sessão apaga a política do canal. Começa DEPOIS que o
    // retrato foi travado, e só consegue commitar quando a ativação soltar.
    const racer = await pool.connect();
    let racerDone = false;
    let racerBlockedDuringDecision: boolean | null = null;
    let racerPromise: Promise<unknown> = Promise.resolve();

    const out = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'activate',
      payload: { confirm_tenant_id: s.tenant, confirm_agent_id: s.agent },
      idempotency_key: 'saga-key-atomic-act',
      expected_version: version,
      actor,
      deps: {
        // Roda DEPOIS de `lockReadinessSnapshot` e ANTES de `applyActivate`:
        // é exatamente a janela que a review descreve.
        evaluateReadiness: async (scope, ctx) => {
          const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');
          const { loadReadinessFactsWith } = await import(
            '../../src/onboarding/readiness-facts.js'
          );

          racerPromise = racer
            .query('BEGIN')
            .then(() =>
              racer.query('DELETE FROM channel_policies WHERE tenant_id=$1 AND agent_id=$2', [
                s.tenant,
                s.agent,
              ]),
            )
            .then(() => racer.query('COMMIT'))
            .then(() => {
              racerDone = true;
            })
            .catch(() => {
              racerDone = true;
            });

          // Dá tempo ao racer de chegar ao DELETE e BLOQUEAR no lock.
          await new Promise((r) => setTimeout(r, 700));
          racerBlockedDuringDecision = !racerDone;

          return evaluateAgentReadiness(
            scope,
            ctx ? { loadFacts: (f) => loadReadinessFactsWith(ctx.tx, f) } : {},
          );
        },
      },
    });

    // O DELETE concorrente ficou BLOQUEADO enquanto a decisão era tomada — é
    // isto que "a decisão e a escrita dependem do mesmo retrato protegido"
    // significa em Postgres. Sem o lock ele teria commitado na hora.
    expect(racerBlockedDuringDecision).toBe(true);

    // A ativação viu o estado íntegro e concluiu, com o canal ROTEANDO.
    expect(out.status).toBe('completed');
    expect(out.status === 'completed' && out.result.activated_channels).toBe(1);

    await racerPromise;
    racer.release();

    const c = await pool.connect();
    try {
      const run = await c.query('SELECT state FROM onboarding_runs WHERE id=$1', [s.run_id]);
      expect(run.rows[0].state).toBe('active');
      const ch = await c.query('SELECT active FROM channels WHERE id=$1', [s.channel_id]);
      expect(ch.rows[0].active).toBe(true);
    } finally {
      c.release();
    }
  });

  /**
   * A segunda metade da correção: `applyActivate` CONFERE o efeito antes de a
   * run poder concluir. Aqui a política some DENTRO da própria transação do
   * passo — o pior caso possível, que nenhum lock poderia impedir.
   *
   * ANTES: `activated_channels` vinha 0 e a run concluía `active` assim mesmo —
   * um agente "ativo" que não roteia em lugar nenhum.
   */
  it('zero linhas governadas ⇒ a run NÃO conclui: vira `readiness_failed`, sem escrita parcial', async () => {
    const { executeOnboardingStep } = await import('../../src/onboarding/wizard.js');
    const s = await driveToChannelReady('verify', '+5511987650046');
    const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: s.tenant };

    const evaluated = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'evaluate_readiness',
      payload: {},
      idempotency_key: 'saga-key-verify-ready',
      expected_version: s.version,
      actor,
    });
    const version = evaluated.status === 'completed' ? evaluated.run.version : 0;

    const out = await executeOnboardingStep({
      run_id: s.run_id,
      step: 'activate',
      payload: { confirm_tenant_id: s.tenant, confirm_agent_id: s.agent },
      idempotency_key: 'saga-key-verify-act',
      expected_version: version,
      actor,
      deps: {
        evaluateReadiness: async (scope, ctx) => {
          const { evaluateAgentReadiness } = await import('../../src/onboarding/readiness.js');
          const { loadReadinessFactsWith } = await import(
            '../../src/onboarding/readiness-facts.js'
          );
          const { sql } = await import('drizzle-orm');
          const r = await evaluateAgentReadiness(
            scope,
            ctx ? { loadFacts: (f) => loadReadinessFactsWith(ctx.tx, f) } : {},
          );
          expect(r.ready).toBe(true);
          // A política some DEPOIS do veredito, na MESMA transação.
          await (ctx!.tx as { execute: (q: unknown) => Promise<unknown> }).execute(
            sql`DELETE FROM channel_policies WHERE tenant_id = ${s.tenant} AND agent_id = ${s.agent}`,
          );
          return r;
        },
      },
    });

    expect(out).toMatchObject({ status: 'denied', code: 'activation_precondition_failed' });

    const c = await pool.connect();
    try {
      const run = await c.query('SELECT state, completed_at FROM onboarding_runs WHERE id=$1', [
        s.run_id,
      ]);
      expect(run.rows[0].state).toBe('readiness_failed');
      expect(run.rows[0].completed_at).toBeNull();
      // NENHUMA escrita parcial: o agente não ficou ativo e a linha não roteia.
      const agent = await c.query('SELECT status FROM agents WHERE id=$1', [s.agent]);
      expect(agent.rows[0].status).toBe('provisioning');
      const ch = await c.query('SELECT active FROM channels WHERE id=$1', [s.channel_id]);
      expect(ch.rows[0].active).toBe(false);
    } finally {
      c.release();
    }
  });
});
