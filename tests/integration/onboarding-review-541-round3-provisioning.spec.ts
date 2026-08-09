/**
 * Issue #519 — a TERCEIRA rodada da review adversarial do PR #541, provada
 * contra Postgres REAL. Dois achados, duas propriedades que só o banco
 * demonstra:
 *
 *   2. [High] `provision_agent` CRIA — nunca adota um agente preexistente do
 *      mesmo tenant. O `INSERT … RETURNING` é o que separa "inseri agora" de
 *      "já estava lá"; o `SELECT` pelo par que havia antes não separava, e a
 *      saga seguia sobrescrevendo a governança de um agente ATIVO.
 *   5. [Medium] o replay de uma NEGAÇÃO devolve o relatório INTEIRO que o
 *      ledger guardou, e não escreve uma segunda linha de auditoria para uma
 *      decisão que aconteceu uma vez só.
 *
 * Pulado sem `TEST_DB_URL`, como as demais suítes de integração — e é por isso
 * que `SHOULD_RUN` exige `DATABASE_URL === TEST_DB_URL`: rodar contra o banco
 * de desenvolvimento seria pior do que não rodar.
 *
 * Cada caso usa um (tenant, agente) PRÓPRIO: `onboarding_runs_one_live_per_agent_uq`
 * e `onboarding_runs_one_live_per_tenant_uq` (migration 113) admitem uma única
 * run viva por escopo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { useExclusivePairingQueue } from './helpers/pairing-queue-lock.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// A fila de `channel_line_state` é global por desenho — ver o helper.
useExclusivePairingQueue();

const ACTOR_ID = 'rev541r3-tester';
// PREFIX distinto do spec irmão (`onboarding-review-541-round3.spec.ts`): os
// dois nasceram do mesmo molde, o vitest roda arquivos em PROCESSOS paralelos e
// cada um reinicia o contador de escopo em zero. Com prefixo igual, os dois
// geram os MESMOS ids de tenant e colidem em `tenants_pkey` — falha que só
// aparece na suíte completa, nunca no arquivo isolado.
const PREFIX = 'rev541r3p';

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
// Driver mínimo: abre a run e a leva até `admin_ready`, que é o estado de onde
// `provision_agent` parte.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cada chamada de `openRunToAdminReady` abre um escopo NOVO — inclusive quando
 * o vitest reexecuta o mesmo `it` (`retry`). Sem isto, a segunda tentativa
 * colidia com o tenant/agente/linha que a primeira deixou no banco e o erro
 * REAL da tentativa 1 ficava soterrado por um `duplicate key` da tentativa 2.
 */
let scopeSeq = 0;

type RunCursor = {
  /** O sufixo único deste escopo — entra em tenant, agente e linha. */
  scope: string;
  tenant: string;
  actor: { actor_id: string; actor_role: 'owner'; tenant_id: string };
  run_id: string;
  version: number;
  step: (
    name: string,
    payload: unknown,
    opts?: { key?: string; version?: number; advance?: boolean },
  ) => Promise<Record<string, unknown>>;
};

async function openRunToAdminReady(base: string): Promise<RunCursor> {
  const { startOnboardingRun, executeOnboardingStep } = await import(
    '../../src/onboarding/wizard.js'
  );
  const suffix = `${base}${++scopeSeq}`;
  const tenant = `${PREFIX}-${suffix}`;
  tenants.add(tenant);
  const actor = { actor_id: ACTOR_ID, actor_role: 'owner' as const, tenant_id: tenant };

  const started = await startOnboardingRun({
    kind: 'tenant_onboarding',
    tenant_id: tenant,
    actor,
    idempotency_key: `${PREFIX}-open-${suffix}-${Date.now()}`,
    metadata: { source: 'cli', intent: 'new_tenant' },
  });
  if (started.status !== 'started') throw new Error(`run não abriu: ${JSON.stringify(started)}`);
  createdRuns.push(started.run.id);

  const cursor: RunCursor = {
    scope: suffix,
    tenant,
    actor,
    run_id: started.run.id,
    version: started.run.version,
    step: async (name, payload, opts = {}) => {
      const out = await executeOnboardingStep({
        run_id: started.run.id,
        step: name,
        payload,
        idempotency_key: opts.key ?? `${PREFIX}-${suffix}-${name}`,
        expected_version: opts.version ?? cursor.version,
        actor,
      });
      if (opts.advance !== false && 'run' in out) cursor.version = out.run.version;
      return out as unknown as Record<string, unknown>;
    },
  };

  await cursor.step('provision_tenant', { tenant_id: tenant, nome: `Rev541r3 ${suffix}` });
  await cursor.step('provision_admin', {
    user_id: `${PREFIX}-${suffix}-admin`,
    email: `${suffix}@rev541r3.test`,
  });
  return cursor;
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) [High] `provision_agent` CRIA. Não adota.
// ─────────────────────────────────────────────────────────────────────────────

d('[High] `provision_agent` não adota um agente preexistente', () => {
  /**
   * (a) O caminho feliz continua feliz — sem ele, "recusa tudo" passaria nos
   * outros dois casos e a correção seria indistinguível de uma quebra.
   */
  it('(a) agente NOVO é criado, com semente de profile e piso de capacidades', async () => {
    const cursor = await openRunToAdminReady('novo');
    const agent = `${PREFIX}-${cursor.scope}-bot`;

    const out = await cursor.step('provision_agent', { agent_id: agent, nome: 'Bot Novo' });
    expect(out.status).toBe('completed');
    expect((out.result as Record<string, unknown>).agent_id).toBe(agent);
    expect((out.result as Record<string, unknown>).status).toBe('provisioning');
    expect((out.result as Record<string, unknown>).seed_profile_version).toBe(1);

    const c = await pool.connect();
    try {
      const a = await c.query('SELECT tenant_id, status FROM agents WHERE id=$1', [agent]);
      expect(a.rows).toHaveLength(1);
      expect(a.rows[0].tenant_id).toBe(cursor.tenant);
      expect(a.rows[0].status).toBe('provisioning');

      const prof = await c.query(
        'SELECT version, status FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2',
        [cursor.tenant, agent],
      );
      expect(prof.rows).toHaveLength(1);
      expect(prof.rows[0].version).toBe(1);
      expect(prof.rows[0].status).toBe('proposed');

      const grants = await c.query(
        'SELECT granted_packs FROM agent_tool_grants WHERE tenant_id=$1 AND agent_id=$2',
        [cursor.tenant, agent],
      );
      expect(grants.rows).toHaveLength(1);

      // O escopo da run passou a apontar para o agente RECÉM-CRIADO.
      const run = await c.query('SELECT agent_id, state FROM onboarding_runs WHERE id=$1', [
        cursor.run_id,
      ]);
      expect(run.rows[0].agent_id).toBe(agent);
      expect(run.rows[0].state).toBe('agent_draft');
    } finally {
      c.release();
    }
  });

  /**
   * (b) O ACHADO. Um agente que JÁ EXISTE no MESMO tenant — ativo, com profile
   * ativo, grants e papel padrão próprios — não é adotado pela saga.
   *
   * Com o `SELECT` pelo par que havia antes do `RETURNING`, este caso era
   * SUCESSO: a releitura encontrava o agente incumbente (mesmo tenant, logo o
   * par casa), o passo devolvia `completed`, gravava uma versão SEMENTE `v1
   * proposed` ao lado do profile ativo e apontava a run para ele. Daí em diante
   * `configure_profile`, `apply_capability_packs` e `configure_role`
   * reescreviam a governança de um agente em produção.
   */
  it('(b) agente JÁ EXISTENTE no MESMO tenant ⇒ `duplicate_agent`, e nada é sobrescrito', async () => {
    const cursor = await openRunToAdminReady('adota');
    const incumbent = `${PREFIX}-${cursor.scope}-bot`;

    // O agente INCUMBENTE, montado direto no banco: ativo e já governado.
    // Deliberadamente com profile na versão 2 — assim a versão SEMENTE `v1`
    // que o passo grava quando adota é um FATO OBSERVÁVEL no banco, e não
    // some dentro de um `ON CONFLICT DO NOTHING`.
    const c0 = await pool.connect();
    let incumbentRole: string;
    try {
      await c0.query(
        `INSERT INTO agents (id, tenant_id, nome, status) VALUES ($1,$2,'Bot Incumbente','active')`,
        [incumbent, cursor.tenant],
      );
      await c0.query(
        `INSERT INTO agent_operational_profile_versions
           (tenant_id, agent_id, version, status, proposed_by, activated_at)
         VALUES ($1,$2,2,'active','producao', now())`,
        [cursor.tenant, incumbent],
      );
      await c0.query(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_by, reason)
         VALUES ($1,$2,$3,'producao','grant incumbente')`,
        [cursor.tenant, incumbent, ['pack.incumbente']],
      );
      const r = await c0.query(
        `INSERT INTO roles (tenant_id, agent_id, role_key, display_name, active, is_default)
         VALUES ($1,$2,'incumbente','Incumbente', true, true) RETURNING id`,
        [cursor.tenant, incumbent],
      );
      incumbentRole = r.rows[0].id as string;
    } finally {
      c0.release();
    }

    let thrown: unknown;
    await cursor
      .step('provision_agent', { agent_id: incumbent, nome: 'Sequestro' }, { advance: false })
      .catch((e) => {
        thrown = e;
      });

    expect((thrown as { code?: string } | undefined)?.code).toBe('duplicate_agent');
    // A recusa não nomeia dono nem tenant — a mesma mensagem que o id de outro
    // tenant recebe. É isso que impede a recusa de virar um oráculo de posse.
    const msg = String((thrown as Error).message);
    expect(msg).not.toContain(cursor.tenant);
    expect(msg).not.toMatch(/outro tenant|este tenant|mesmo tenant/i);

    const c = await pool.connect();
    try {
      // O incumbente continua exatamente como estava.
      const a = await c.query('SELECT status, nome FROM agents WHERE id=$1', [incumbent]);
      expect(a.rows[0].status).toBe('active');
      expect(a.rows[0].nome).toBe('Bot Incumbente');

      // NENHUMA versão semente foi enxertada ao lado do profile ativo.
      const prof = await c.query(
        'SELECT version, status FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2 ORDER BY version',
        [cursor.tenant, incumbent],
      );
      expect(prof.rows).toHaveLength(1);
      expect(prof.rows[0].version).toBe(2);
      expect(prof.rows[0].status).toBe('active');

      // Grants e papel padrão intactos.
      const grants = await c.query(
        'SELECT granted_packs FROM agent_tool_grants WHERE tenant_id=$1 AND agent_id=$2',
        [cursor.tenant, incumbent],
      );
      expect(grants.rows).toHaveLength(1);
      expect(grants.rows[0].granted_packs).toEqual(['pack.incumbente']);

      const roles = await c.query(
        'SELECT id, role_key FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND is_default=true',
        [cursor.tenant, incumbent],
      );
      expect(roles.rows).toHaveLength(1);
      expect(roles.rows[0].id).toBe(incumbentRole);
      expect(roles.rows[0].role_key).toBe('incumbente');

      // E a run NÃO adotou o escopo alheio: continua sem agente, em
      // `admin_ready`, com a versão intacta (o `apply` lançou, o tx rolou).
      const run = await c.query(
        'SELECT agent_id, state, version FROM onboarding_runs WHERE id=$1',
        [cursor.run_id],
      );
      expect(run.rows[0].agent_id).toBeNull();
      expect(run.rows[0].state).toBe('admin_ready');
      expect(run.rows[0].version).toBe(cursor.version);
    } finally {
      c.release();
    }
  });

  /**
   * (c) A NÃO-REGRESSÃO que a correção não pode custar: o retry legítimo.
   *
   * O ledger de idempotência (migration 113) resolve a MESMA (run, passo,
   * chave) em `commitStep` ANTES de o `apply` rodar — e é por isso que a
   * criação estrita não transforma um retry em `duplicate_agent`. A linha do
   * ledger e o `INSERT` do agente são gravados na MESMA transação: não existe
   * janela em que o agente exista e o ledger não saiba.
   */
  it('(c) replay da MESMA chave devolve o resultado anterior — nunca `duplicate_agent`', async () => {
    const cursor = await openRunToAdminReady('replay');
    const agent = `${PREFIX}-${cursor.scope}-bot`;
    const key = `${PREFIX}-${cursor.scope}-provision-agent`;
    const versionBefore = cursor.version;

    const first = await cursor.step(
      'provision_agent',
      { agent_id: agent, nome: 'Bot Replay' },
      { key },
    );
    expect(first.status).toBe('completed');
    expect(first.replayed).toBe(false);

    // O retry carrega a versão ANTIGA — é o cenário real: o cliente nunca viu
    // a resposta, logo nunca viu a versão nova.
    const second = await cursor.step(
      'provision_agent',
      { agent_id: agent, nome: 'Bot Replay' },
      { key, version: versionBefore, advance: false },
    );

    expect(second.status).toBe('completed');
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);

    const c = await pool.connect();
    try {
      // Um agente, uma semente, um grant — o replay não duplicou nada.
      const a = await c.query('SELECT id FROM agents WHERE tenant_id=$1', [cursor.tenant]);
      expect(a.rows).toHaveLength(1);
      const prof = await c.query(
        'SELECT version FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2',
        [cursor.tenant, agent],
      );
      expect(prof.rows).toHaveLength(1);

      // E o replay ficou registrado como replay, não como um segundo commit.
      const events = await c.query(
        `SELECT event_type FROM onboarding_events
         WHERE run_id=$1 AND step='provision_agent' ORDER BY created_at`,
        [cursor.run_id],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(['step_completed', 'step_replayed']);
    } finally {
      c.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) [Medium] O replay de uma NEGAÇÃO devolve o relatório inteiro e NÃO
//     reaudita.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Leva uma run de ZERO até `channel_ready` — o estado de onde
 * `evaluate_readiness` parte.
 */
async function driveToChannelReady(
  base: string,
): Promise<RunCursor & { agent: string; channel_id: string; role_id: string }> {
  const cursor = await openRunToAdminReady(base);
  const suffix = cursor.scope;
  const agent = `${PREFIX}-${suffix}-bot`;
  // A linha também sai do contador: `channels.external_id` é único entre canais
  // ativos no banco INTEIRO, não por tenant.
  const line = `+551198765${String(3000 + scopeSeq).padStart(4, '0')}`;

  await cursor.step('provision_agent', { agent_id: agent, nome: `Bot ${suffix}` });
  await cursor.step('configure_profile', { approve: true });
  await cursor.step('apply_capability_packs', { granted_packs: [], denied_tools: [] });
  await cursor.step('configure_role', {
    role_key: 'atendente',
    display_name: 'Atendente',
    granted_packs: [],
  });
  const declared = await cursor.step('declare_channel', {
    channel_type: 'whatsapp',
    external_id: line,
    display_name: `Linha ${suffix}`,
  });
  const channel_id = (declared.result as Record<string, unknown>).channel_id as string;

  await cursor.step('start_pairing', { channel_id, method: 'qr' });

  const c = await pool.connect();
  let role_id: string;
  try {
    await c.query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      channel_id,
    ]);
    const roles = await c.query(
      'SELECT id FROM roles WHERE tenant_id=$1 AND agent_id=$2 AND is_default=true',
      [cursor.tenant, agent],
    );
    role_id = roles.rows[0].id as string;
  } finally {
    c.release();
  }

  await cursor.step('confirm_channel_ready', { channel_id });
  return Object.assign(cursor, { agent, channel_id, role_id });
}

d('[Medium] o replay de uma readiness NEGADA é a MESMA resposta, contada uma vez', () => {
  it('devolve o relatório completo e deixa UMA linha em `audit_log`', async () => {
    const s = await driveToChannelReady('replaydeny');

    // Quebra a precondição: o papel padrão que governa o canal fica INATIVO.
    // `channel_policy_role_active` reprova, `readiness.ready` vira false, e
    // `evaluate_readiness` NEGA — que é o caminho de que este teste trata.
    const c0 = await pool.connect();
    try {
      await c0.query('UPDATE roles SET active=false WHERE id=$1', [s.role_id]);
    } finally {
      c0.release();
    }

    const key = `${PREFIX}-${s.scope}-evaluate`;
    const versionBefore = s.version;

    const first = await s.step('evaluate_readiness', {}, { key });
    expect(first.status).toBe('denied');
    expect(first.code).toBe('readiness_blocked');

    const firstReport = first.readiness as {
      ready: boolean;
      checks: { code: string; status: string; message: string; remediation: string }[];
      channels: { channel_id: string; activatable: boolean; failed_checks: string[] }[];
      activatable_channel_ids: string[];
      configuration_fingerprint: string;
    };
    expect(firstReport).toBeDefined();
    expect(firstReport.ready).toBe(false);
    const firstFailed = firstReport.checks.filter((k) => k.status === 'fail').map((k) => k.code);
    expect(firstFailed).toContain('channel_policy_role_active');
    // O que o replay perdia: mensagem e REMEDIAÇÃO. Sem elas, a resposta diz
    // que foi recusado e não diz o que fazer.
    const firstRemediations = firstReport.checks
      .filter((k) => k.status === 'fail')
      .map((k) => k.remediation);
    expect(firstRemediations.every((r) => r.length > 0)).toBe(true);

    // Quantas linhas de auditoria a decisão deixou.
    const auditRows = async () => {
      const c = await pool.connect();
      try {
        const r = await c.query(
          `SELECT id FROM audit_log
           WHERE tenant_id=$1 AND agent_id=$2 AND acao='agent_readiness_evaluated'`,
          [s.tenant, s.agent],
        );
        return r.rows.length;
      } finally {
        c.release();
      }
    };
    expect(await auditRows()).toBe(1);

    // ── O REPLAY: mesma chave, mesmo payload, versão ANTIGA (o cliente nunca
    //    viu a resposta, logo nunca viu a versão nova).
    const second = await s.step('evaluate_readiness', {}, { key, version: versionBefore });

    expect(second.status).toBe('denied');
    expect(second.code).toBe('readiness_blocked');
    expect(second.message).toBe(first.message);

    const secondReport = second.readiness as typeof firstReport;
    expect(secondReport).toBeDefined();
    // O relatório INTEIRO volta — não uma aproximação, não só code/message.
    expect(secondReport).toEqual(firstReport);
    expect(secondReport.checks.filter((k) => k.status === 'fail').map((k) => k.code)).toEqual(
      firstFailed,
    );
    expect(
      secondReport.checks.filter((k) => k.status === 'fail').every((k) => k.remediation.length > 0),
    ).toBe(true);
    expect(secondReport.configuration_fingerprint).toBe(firstReport.configuration_fingerprint);

    // ── E a decisão continua tendo acontecido UMA vez. `audit()` engole falhas
    //    por design (best-effort), então contar chamadas não prova nada:
    //    contamos LINHAS no banco.
    expect(await auditRows()).toBe(1);

    const c = await pool.connect();
    try {
      // A trilha de governança transacional também não duplicou.
      const admin = await c.query(
        `SELECT action FROM admin_audit_log
         WHERE tenant_id=$1 AND action='onboarding_readiness_evaluated_denied'`,
        [s.tenant],
      );
      expect(admin.rows).toHaveLength(1);

      // O ledger guardou UM resultado conclusivo, do tipo certo.
      const ledger = await c.query(
        `SELECT outcome_kind, outcome_code FROM onboarding_step_results
         WHERE run_id=$1 AND step='evaluate_readiness'`,
        [s.run_id],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].outcome_kind).toBe('denied');
      expect(ledger.rows[0].outcome_code).toBe('readiness_blocked');

      // E o replay ficou registrado onde pertence: um evento append-only da
      // saga, não uma segunda decisão de governança.
      const events = await c.query(
        `SELECT event_type FROM onboarding_events
         WHERE run_id=$1 AND step='evaluate_readiness' ORDER BY created_at`,
        [s.run_id],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(['step_denied', 'step_replayed']);
    } finally {
      c.release();
    }
  });
});
