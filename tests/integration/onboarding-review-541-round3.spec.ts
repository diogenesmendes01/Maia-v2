/**
 * Issue #519 — TERCEIRA rodada da review adversarial do PR #541, provada
 * contra Postgres REAL. Dois achados High, o mesmo dono:
 *
 *   1. [High] o pareamento tornava o canal ROTEÁVEL antes da ativação final da
 *      saga. Agora, enquanto a run de onboarding está viva, ela é a dona da
 *      ativação: o pareamento verifica posse e para. O caminho de #518 (fora do
 *      onboarding) continua ativando — os DOIS lados estão provados aqui.
 *
 *   3. [High] a ativação final ligava o conjunto revalidado mas não DESLIGAVA
 *      os canais governados excluídos. Um canal cujo papel foi desativado
 *      seguia roteando. Agora o conjunto exato é aplicado atomicamente:
 *      `active=true` nos válidos e `active=false` nos governados excluídos,
 *      sob os mesmos locks, com contagem conferida e desativação AUDITADA.
 *
 * Estes casos dirigem o CAMINHO REAL: o wizard real (`executeOnboardingStep`),
 * o `startChannelPairing` real (o mesmo que o worker `channel_pairing` chama) e
 * o gate `evaluateLineReadiness` real. O único duplo é o transporte Baileys —
 * não há socket WhatsApp num teste.
 *
 * Pulado sem `TEST_DB_URL`, como as demais suítes de integração.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { useExclusivePairingQueue } from './helpers/pairing-queue-lock.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// A fila de `channel_line_state` é global por desenho — ver o helper.
useExclusivePairingQueue();

// ─────────────────────────────────────────────────────────────────────────────
// Os ÚNICOS duplos: o transporte. Tudo o mais é o código de produção contra o
// Postgres real.
// ─────────────────────────────────────────────────────────────────────────────
const { managerMock, startLineSessionMock } = vi.hoisted(() => ({
  managerMock: {
    startPairingSession: vi.fn(),
    abortPairing: vi.fn(async () => undefined),
  },
  startLineSessionMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => managerMock,
  lineAuthDir: (id: string) => `/tmp/maia-rev541r3/lines/${id}`,
  pairingAuthDir: (id: string) => `/tmp/maia-rev541r3/pairing/${id}`,
}));
vi.mock('../../src/gateway/line-sessions.js', () => ({
  _internal: { startLineSession: startLineSessionMock },
  startAdditionalLineSessions: vi.fn(async () => undefined),
}));
// `MAIA_MULTI_LINE` ligado: é a condição em que "ativar" e "subir socket"
// acontecem juntos. Com a flag desligada o teste não conseguiria distinguir
// "não ativou" de "ativou mas não roteia ainda".
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { ...actual, config: { ...actual.config, MAIA_MULTI_LINE: true } };
});

const ACTOR_ID = 'rev541r3-tester';
const PREFIX = 'rev541r3';

const tenants = new Set<string>();
const createdRuns: string[] = [];
let pool: pg.Pool;

beforeAll(() => {
  if (SHOULD_RUN) pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
});

beforeEach(() => {
  managerMock.startPairingSession.mockReset();
  startLineSessionMock.mockClear();
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
// Driver da saga — escopo próprio por caso (mesmo padrão da rodada 2)
// ─────────────────────────────────────────────────────────────────────────────

type SagaState = {
  tenant: string;
  agent: string;
  actor: { actor_id: string; actor_role: 'owner'; tenant_id: string };
  run_id: string;
  channel_id: string;
  role_id: string;
  step: (name: string, payload: unknown) => Promise<{ result: Record<string, unknown> }>;
};

/**
 * Escopo NOVO a cada chamada — inclusive entre o `retry: 1` do vitest.
 * `onboarding_runs_one_live_per_agent_uq` admite uma única run viva por agente,
 * então reaproveitar o par transformaria a segunda tentativa num 23505 que
 * esconde a falha real.
 */
let scopeSeq = 0;
function nextScope(tag: string): { suffix: string; line: string } {
  scopeSeq += 1;
  return {
    suffix: `${tag}${scopeSeq}`,
    line: `+55119${String(70000000 + scopeSeq).slice(-8)}`,
  };
}

async function driveToChannelDeclared(tag: string): Promise<SagaState> {
  const { startOnboardingRun, executeOnboardingStep } = await import(
    '../../src/onboarding/wizard.js'
  );
  const { suffix, line } = nextScope(tag);
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
    return out as unknown as { result: Record<string, unknown> };
  };

  await step('provision_tenant', { tenant_id: tenant, nome: `Rev541r3 ${suffix}` });
  await step('provision_admin', {
    user_id: `${PREFIX}-${suffix}-admin`,
    email: `${suffix}@rev541r3.test`,
  });
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
  const channel_id = declared.result.channel_id as string;

  const c = await pool.connect();
  let role_id: string;
  try {
    const roles = await c.query(
      'SELECT id FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND is_default=true',
      [tenant, agent],
    );
    role_id = roles.rows[0].id;
  } finally {
    c.release();
  }

  return { tenant, agent, actor, run_id: view.id, channel_id, role_id, step };
}

/** Resolve a promise da PairingSession com posse PROVADA. */
function matchedPairing(): void {
  managerMock.startPairingSession.mockResolvedValue({ matched: true, actual_line: null });
}

async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await pool.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    c.release();
  }
}

/**
 * O efeito de `startChannelPairing` roda em background (a promise da
 * PairingSession). Espera pela EVIDÊNCIA no banco em vez de por um tick
 * arbitrário — e é a mesma asserção que prova que a linha CHEGOU no
 * `audit_log` (o `audit()` engole falhas por design).
 */
async function waitForAudit(
  tenant: string,
  acao: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await query<{ acao: string; metadata: Record<string, unknown> }>(
      'SELECT acao, metadata FROM audit_log WHERE tenant_id=$1 AND acao=$2 ORDER BY created_at DESC LIMIT 1',
      [tenant, acao],
    );
    if (rows[0]) return rows[0].metadata;
    if (Date.now() > deadline) throw new Error(`audit_log sem '${acao}' para ${tenant}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

d('achado 1 [High] — o pareamento do onboarding VERIFICA posse; não ativa e não roteia', () => {
  it('run VIVA: posse provada, canal continua active=false e NENHUMA sessão de linha sobe', async () => {
    const s = await driveToChannelDeclared('a1live');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });

    // Pré-condição do teste: tudo o que o gate de LINHA exige está pronto —
    // perfil ativo, política do canal e papel default ativo. Sem isso o teste
    // passaria pelo motivo errado.
    const pre = await query<{ has_policy: boolean; role_active: boolean; profile: number }>(
      `SELECT (SELECT count(*) FROM channel_policies WHERE channel_id=$1) > 0 AS has_policy,
              (SELECT bool_and(active) FROM roles WHERE tenant_id=$2 AND agent_id=$3 AND is_default) AS role_active,
              (SELECT count(*) FROM agent_operational_profile_versions
                 WHERE tenant_id=$2 AND agent_id=$3 AND status='active')::int AS profile`,
      [s.channel_id, s.tenant, s.agent],
    );
    expect(pre[0]).toMatchObject({ has_policy: true, role_active: true, profile: 1 });

    // CAMINHO REAL: é esta função que o worker `channel_pairing` chama ao
    // consumir o `start_pairing` que a saga acabou de enfileirar.
    const { startChannelPairing, _resetChannelPairingsForTests } = await import(
      '../../src/setup/line-pairing.js'
    );
    _resetChannelPairingsForTests();
    matchedPairing();
    expect(await startChannelPairing({ channel_id: s.channel_id, method: 'qr' })).toEqual({
      ok: true,
    });

    // `pairing_session_verified` é emitido nos DOIS desfechos (adiado e
    // ativado), e no desfecho ATIVADO ele vem DEPOIS de `activateVerified`.
    // Esperar por ele é, portanto, um ponto de sincronização neutro: quando
    // chega, o efeito colateral do caminho defeituoso já teria acontecido.
    const verified = await waitForAudit(s.tenant, 'pairing_session_verified');

    // A PROVA: o canal NÃO roteia.
    const ch = await query<{ active: boolean }>('SELECT active FROM channels WHERE id=$1', [
      s.channel_id,
    ]);
    expect(ch[0]!.active).toBe(false);
    // E a sessão de linha não subiu — `MAIA_MULTI_LINE` está ligado, então
    // "não chamou" aqui significa mesmo "não roteia".
    expect(startLineSessionMock).not.toHaveBeenCalled();
    // A verificação de POSSE, essa sim, aconteceu e ficou registrada.
    expect(verified).toMatchObject({ channel_id: s.channel_id, routing_activated: false });

    const deferred = await waitForAudit(s.tenant, 'channel_activation_deferred');
    expect(deferred).toMatchObject({
      channel_id: s.channel_id,
      reason: 'onboarding_saga_owns_activation',
    });
  });

  it('o gate consultado pelo worker (`promoteReadyVerifiedLines`) também recusa a linha da saga', async () => {
    const s = await driveToChannelDeclared('a1worker');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });
    await query(`UPDATE channel_line_state SET state='verified_offline' WHERE channel_id=$1`, [
      s.channel_id,
    ]);

    // `evaluateLineReadiness` é a ÚNICA porta do maquinário de #518: o worker
    // a consulta a cada minuto para promover linhas `verified_offline`. Se a
    // recusa vivesse só dentro de `startChannelPairing`, o worker ativaria a
    // linha da saga sessenta segundos depois.
    const { evaluateLineReadiness } = await import('../../src/setup/line-readiness.js');
    expect(
      await evaluateLineReadiness({
        id: s.channel_id,
        tenant_id: s.tenant,
        agent_id: s.agent,
      }),
    ).toEqual({ ready: false, reason_code: 'onboarding_saga_owns_activation' });
  });

  it('FORA do onboarding (#518): sem run viva o pareamento ativa e sobe a sessão — o caminho legado não quebrou', async () => {
    // Mesmo escopo, mesma configuração; a única diferença é que a run chegou ao
    // fim (estado TERMINAL). É o caso de RECOVERY de linha de agente já ativo.
    const s = await driveToChannelDeclared('a1free');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });
    await query(`UPDATE onboarding_runs SET state='active' WHERE id=$1`, [s.run_id]);

    const { startChannelPairing, _resetChannelPairingsForTests } = await import(
      '../../src/setup/line-pairing.js'
    );
    _resetChannelPairingsForTests();
    matchedPairing();
    expect(await startChannelPairing({ channel_id: s.channel_id, method: 'qr' })).toEqual({
      ok: true,
    });

    const activated = await waitForAudit(s.tenant, 'channel_activated');
    expect(activated).toMatchObject({ channel_id: s.channel_id, trigger: 'pairing_verified' });

    const ch = await query<{ active: boolean }>('SELECT active FROM channels WHERE id=$1', [
      s.channel_id,
    ]);
    expect(ch[0]!.active).toBe(true);
    expect(startLineSessionMock).toHaveBeenCalledTimes(1);
    expect(startLineSessionMock.mock.calls[0]![0]).toMatchObject({
      id: s.channel_id,
      tenant_id: s.tenant,
      agent_id: s.agent,
    });
  });

  it('o passo `activate` da saga é quem liga o canal E sobe a sessão de linha', async () => {
    const s = await driveToChannelDeclared('a1act');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });
    await query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      s.channel_id,
    ]);
    await s.step('confirm_channel_ready', { channel_id: s.channel_id });
    await s.step('evaluate_readiness', {});
    const out = await s.step('activate', {
      confirm_tenant_id: s.tenant,
      confirm_agent_id: s.agent,
    });

    expect(out.result.activated_channel_ids).toEqual([s.channel_id]);
    const ch = await query<{ active: boolean }>('SELECT active FROM channels WHERE id=$1', [
      s.channel_id,
    ]);
    expect(ch[0]!.active).toBe(true);
    expect(startLineSessionMock).toHaveBeenCalledTimes(1);
    expect(startLineSessionMock.mock.calls[0]![0]).toMatchObject({ id: s.channel_id });
  });
});

d('achado 3 [High] — a ativação aplica o CONJUNTO EXATO: liga os válidos e desliga os excluídos', () => {
  it('canal governado que ficou inválido e ESTAVA ativo é DESATIVADO na mesma transação, e a desativação é auditada', async () => {
    const s = await driveToChannelDeclared('a3set');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });
    await query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      s.channel_id,
    ]);
    await s.step('confirm_channel_ready', { channel_id: s.channel_id });

    // Segundo canal do MESMO agente: governado (tem política do escopo), com
    // posse provada, mas apontando para um papel DESATIVADO. É o canal que o
    // readiness exclui — e que, por já estar ATIVO, seguia roteando.
    const badRole = await query<{ id: string }>(
      `INSERT INTO roles (tenant_id, agent_id, role_key, display_name, active, is_default)
       VALUES ($1,$2,'desligado','Desligado', false, false) RETURNING id`,
      [s.tenant, s.agent],
    );
    const broken = await query<{ id: string }>(
      `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1,$2,'whatsapp',$3,'Linha quebrada', true, false) RETURNING id`,
      [s.tenant, s.agent, nextScope('extra').line],
    );
    const brokenId = broken[0]!.id;
    await query(
      `INSERT INTO channel_policies (tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1,$2,$3,$4,'locked')`,
      [s.tenant, s.agent, brokenId, badRole[0]!.id],
    );
    await query(
      `INSERT INTO channel_line_state (channel_id, tenant_id, agent_id, state)
       VALUES ($1,$2,$3,'connected')`,
      [brokenId, s.tenant, s.agent],
    );

    // Pré-condição: ele ESTÁ roteando agora.
    const before = await query<{ active: boolean }>('SELECT active FROM channels WHERE id=$1', [
      brokenId,
    ]);
    expect(before[0]!.active).toBe(true);

    await s.step('evaluate_readiness', {});
    const out = await s.step('activate', {
      confirm_tenant_id: s.tenant,
      confirm_agent_id: s.agent,
    });

    // Readiness é EXISTENCIAL — o canal bom sozinho basta para o agente subir.
    expect(out.result.activated_channel_ids).toEqual([s.channel_id]);
    expect(out.result.deactivated_channel_ids).toEqual([brokenId]);

    const after = await query<{ id: string; active: boolean }>(
      'SELECT id, active FROM channels WHERE tenant_id=$1 AND agent_id=$2 ORDER BY id',
      [s.tenant, s.agent],
    );
    const byId = new Map(after.map((r) => [r.id, r.active]));
    // Cada canal é FAIL-CLOSED INDIVIDUALMENTE.
    expect(byId.get(s.channel_id)).toBe(true);
    expect(byId.get(brokenId)).toBe(false);

    // Um canal que roteava e deixou de rotear é decisão de GOVERNANÇA: tem que
    // estar na trilha, com o motivo tipado.
    const trail = await query<{
      action: string;
      resource_id: string;
      change_summary: Record<string, unknown>;
    }>(
      `SELECT action, resource_id, change_summary FROM admin_audit_log
        WHERE tenant_id=$1 AND action='onboarding_channel_deactivated'`,
      [s.tenant],
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]!.resource_id).toBe(brokenId);
    expect(trail[0]!.change_summary).toMatchObject({
      agent_id: s.agent,
      failed_checks: ['channel_policy_role_active'],
      was_active: true,
    });
  });

  it('o agente sobe com as linhas prontas — um canal quebrado NÃO derruba os válidos', async () => {
    const s = await driveToChannelDeclared('a3keep');
    await s.step('start_pairing', { channel_id: s.channel_id, method: 'qr' });
    await query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      s.channel_id,
    ]);
    await s.step('confirm_channel_ready', { channel_id: s.channel_id });

    // Governado, papel ATIVO, mas SEM posse provada — excluído por outro
    // predicado, e nunca esteve ativo.
    const noOwnership = await query<{ id: string }>(
      `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, display_name, active, is_synthetic)
       VALUES ($1,$2,'whatsapp',$3,'Sem posse', false, false) RETURNING id`,
      [s.tenant, s.agent, nextScope('extra').line],
    );
    await query(
      `INSERT INTO channel_policies (tenant_id, agent_id, channel_id, default_role_id, switch_behavior)
       VALUES ($1,$2,$3,$4,'locked')`,
      [s.tenant, s.agent, noOwnership[0]!.id, s.role_id],
    );

    await s.step('evaluate_readiness', {});
    const out = await s.step('activate', {
      confirm_tenant_id: s.tenant,
      confirm_agent_id: s.agent,
    });

    expect(out.result.activated_channel_ids).toEqual([s.channel_id]);
    // Já estava inativo: nada mudou, nada a auditar.
    expect(out.result.deactivated_channel_ids).toEqual([]);
    const rows = await query<{ id: string; active: boolean }>(
      'SELECT id, active FROM channels WHERE tenant_id=$1 AND agent_id=$2',
      [s.tenant, s.agent],
    );
    const byId = new Map(rows.map((r) => [r.id, r.active]));
    expect(byId.get(s.channel_id)).toBe(true);
    expect(byId.get(noOwnership[0]!.id)).toBe(false);
    const trail = await query(
      `SELECT 1 FROM admin_audit_log WHERE tenant_id=$1 AND action='onboarding_channel_deactivated'`,
      [s.tenant],
    );
    expect(trail).toHaveLength(0);
  });
});
