/**
 * SC03-AC01 (correção pós-QA239/240) — o CAS da ativação é ATÔMICO também
 * contra `UPDATE`/`DELETE` concorrentes de `agent_engine_policies`.
 *
 * ─── O achado que este arquivo prende ───────────────────────────────────────
 *
 * O QA independente (t_0230398b, parecer #239) reproduziu em Postgres REAL:
 * dentro de `withTx`, `lockReadinessSnapshot` → releitura das linhas de
 * política → um `UPDATE` concorrente de OUTRA conexão (hermes → maia_react,
 * `row_version` 1 → 2) era aplicado em ~1ms. A revalidação CAS já tinha
 * passado, então `applyActivate` committava sobre um retrato que não valia
 * mais. `INSERT` de linha nova já era barrado pela FK composta para `channels`
 * (que a ativação trava com `FOR UPDATE`); o buraco era `UPDATE`/`DELETE` de
 * linha EXISTENTE.
 *
 * ─── Os três casos, e por que os três ───────────────────────────────────────
 *
 *   1. COM a trava (`lockEnginePolicyBindings`, o código de PRODUÇÃO): as duas
 *      escritas concorrentes esperam e são canceladas com `55P03`
 *      (`lock_not_available`, via `lock_timeout`), e a releitura do CAS dentro
 *      da MESMA transação continua vendo o mesmo retrato.
 *   2. SEM a trava (o estado pré-correção, com o mesmo `lockReadinessSnapshot`):
 *      o `UPDATE` ENTRA e commita, e a releitura do CAS passa a ver outro
 *      `binding_revision` DENTRO da mesma transação. É o controle CAUSAL
 *      permanente: sem ele, o caso 1 não provaria que é a trava que fecha a
 *      janela — provaria só que "algo" bloqueia.
 *   3. Na ATIVAÇÃO REAL (saga completa, `executeOnboardingStep`): a sonda roda
 *      no MESMO ponto em que o escritor concorrente chegaria — a porta de
 *      evidência, chamada depois dos locks e antes de `applyActivate` — e é
 *      recusada; fora da transação da ativação, a MESMA sonda entra. A ativação
 *      termina com o retrato intacto.
 *
 * Nada é dublê do que está sob prova: Postgres real, wizard real, repositórios
 * e avaliador reais. As duas únicas portas injetadas são a de pareamento (o
 * worker `channel_pairing` não roda aqui) e a de EVIDÊNCIA de implantação, que
 * é a única parte do readiness que não mora no banco — a fixture é SINTÉTICA e
 * declarada como tal, como o SC03-AC03 exige.
 *
 * Skipped sem `TEST_DB_URL`, como as demais suítes de integração.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { useExclusivePairingQueue } from './helpers/pairing-queue-lock.js';
import { db } from '@/db/client.js';
import {
  ENGINE_REQUIRED_DATA_POLICY_CLASSES,
  engineBindingRevision,
  type EngineDeploymentEvidenceV1,
} from '@/onboarding/readiness.js';
import { lockReadinessSnapshot } from '@/onboarding/readiness-facts.js';
import {
  loadEnginePolicyBindingsWith,
  lockEnginePolicyBindings,
} from '@/db/repositories/engine-policy-repos.js';
import { HERMES_ENGINE_ADAPTER_REVISION } from '@/runtime/engines/hermes-engine.js';
import { HERMES_WORKER_PROTOCOL_VERSION } from '@/integrations/hermes/protocol.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// A fila de `channel_line_state` é global por desenho — ver o helper.
useExclusivePairingQueue();

const PREFIX = 'sc03lock';
/** Curto de propósito: o caso mede BLOQUEIO, e 400ms é folga sobre o ~1ms. */
const LOCK_TIMEOUT = '400ms';

let pool: pg.Pool;
const tenants = new Set<string>();
const createdRuns: string[] = [];

beforeAll(() => {
  if (SHOULD_RUN) pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 6 });
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
      await c.query('DELETE FROM agent_engine_policies WHERE tenant_id=$1', [t]);
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
    await c.query('DELETE FROM admin_audit_log WHERE actor_id LIKE $1', [`${PREFIX}%`]);
    for (const t of tenants) {
      await c.query('DELETE FROM admin_audit_log WHERE tenant_id=$1', [t]);
      await c.query('DELETE FROM tenants WHERE id=$1', [t]);
    }
  } finally {
    c.release();
    await pool.end();
  }
});

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

let seq = 0;

/**
 * Escopo NOVO a cada caso — inclusive entre as duas TENTATIVAS do `retry: 1`
 * do vitest, que herdaria `onboarding_runs_one_live_per_agent_uq` e a
 * unicidade GLOBAL de linha ativa (`channels_active_line_uq`).
 */
function novoEscopo(tag: string): { tenant: string; agent: string; line: string } {
  seq += 1;
  const suffix = `${tag}${seq}-${randomUUID().slice(0, 8)}`;
  tenants.add(`${PREFIX}-${suffix}`);
  const n = 10_000_000 + Math.floor(Math.random() * 70_000_000);
  return {
    tenant: `${PREFIX}-${suffix}`,
    agent: `${PREFIX}-${suffix}-bot`,
    line: `+55117${String(n).padStart(8, '0').slice(-8)}`,
  };
}

/** Identidades mínimas para os casos 1 e 2 (o caso 3 as provisiona pela saga). */
async function mkIdentidades(tenant: string, agent: string): Promise<void> {
  await query('INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [tenant]);
  await query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

async function mkCanal(tenant: string, agent: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO channels (tenant_id, agent_id, channel_type, external_id, active)
     VALUES ($1, $2, 'web', $3, true) RETURNING id`,
    [tenant, agent, `${PREFIX}-${randomUUID()}`],
  );
  return rows[0]!.id;
}

/**
 * A linha que PEDE o motor remoto. Escrita por SQL direto porque o escritor de
 * produção (console) ainda não existe — ver o cabeçalho de
 * `src/db/repositories/engine-policy-repos.ts`.
 */
async function mkPoliticaHermes(
  tenant: string,
  agent: string,
  channel_id: string,
): Promise<number> {
  const rows = await query<{ row_version: number }>(
    `INSERT INTO agent_engine_policies (tenant_id, agent_id, channel_id, engine, updated_by)
     VALUES ($1, $2, $3, 'hermes', $4)
     RETURNING row_version::int AS row_version`,
    [tenant, agent, channel_id, `${PREFIX}-tester`],
  );
  return rows[0]!.row_version;
}

type Tentativa = { aplicou: boolean; rowCount: number; code: string | null };

/**
 * O escritor CONCORRENTE: outra conexão, com `lock_timeout` curto, tentando
 * `UPDATE`/`DELETE` da linha existente — o mesmo formato da sonda de
 * `tests/integration/migration-115-constraint-swap.spec.ts`.
 *
 * Autocommit de propósito: a escrita que estoura o `lock_timeout` aborta
 * sozinha e NADA fica aplicado (não há transação aberta para desfazer), e a que
 * passa COMMITA, como faria um escritor de verdade. O `lock_timeout` é de
 * SESSÃO e volta a 0 no `finally` — a conexão é devolvida ao pool limpa.
 */
async function tentarEscritaConcorrente(
  channel_id: string,
  row_version: number,
  escrita: 'update' | 'delete',
): Promise<Tentativa> {
  const c = await pool.connect();
  try {
    await c.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    try {
      const r =
        escrita === 'update'
          ? await c.query(
              `UPDATE agent_engine_policies
                  SET engine = 'maia_react', row_version = row_version + 1, updated_at = now()
                WHERE channel_id = $1 AND row_version = $2`,
              [channel_id, row_version],
            )
          : await c.query(
              `DELETE FROM agent_engine_policies WHERE channel_id = $1 AND row_version = $2`,
              [channel_id, row_version],
            );
      return { aplicou: (r.rowCount ?? 0) === 1, rowCount: r.rowCount ?? 0, code: null };
    } catch (err) {
      return { aplicou: false, rowCount: 0, code: (err as { code?: string }).code ?? null };
    } finally {
      await c.query('SET lock_timeout = 0').catch(() => undefined);
    }
  } finally {
    c.release();
  }
}

/**
 * A evidência de implantação SINTÉTICA completa, com o pin DESTE build (é o
 * que `engine_runtime_compatible` compara). Produção não tem esta porta
 * preenchida: o default do readiness é o portão FECHADO (SC03-AC03).
 */
function evidenciaSintetica(): EngineDeploymentEvidenceV1 {
  return {
    evidence_class: 'synthetic',
    revision: 'ev-sc03-lock',
    bundle: {
      id: 'bundle-sc03',
      digest: 'd'.repeat(64),
      approved_by: 'operador-sc03',
      approved_at: '2026-09-01T00:00:00.000Z',
    },
    runtime_pin: {
      hermes_sha: 'h'.repeat(40),
      adapter_revision: HERMES_ENGINE_ADAPTER_REVISION,
      protocol: HERMES_WORKER_PROTOCOL_VERSION,
    },
    data_policy: {
      policy_id: 'dp-sc03',
      classes: [...ENGINE_REQUIRED_DATA_POLICY_CLASSES],
      approved: true,
    },
    limits: { max_iterations: 8, max_output_tokens_per_call: 2048, max_inference_calls: 12 },
  };
}

d('SC03-AC01 — a ativação trava as linhas de política do escopo (Postgres real)', () => {
  it('1. COM a trava: UPDATE e DELETE concorrentes esperam (55P03) e o retrato não muda', async () => {
    const { tenant, agent } = novoEscopo('a1');
    await mkIdentidades(tenant, agent);
    const canal = await mkCanal(tenant, agent);
    const versao = await mkPoliticaHermes(tenant, agent, canal);
    const scope = { tenant_id: tenant, agent_id: agent };

    await db.transaction(async (tx) => {
      // A MESMA sequência da ativação: retrato de readiness e, em seguida, a
      // trava das linhas de política — a função de PRODUÇÃO.
      await lockReadinessSnapshot(tx, scope);
      await lockEnginePolicyBindings(tx, scope);

      const antes = await loadEnginePolicyBindingsWith(tx, scope);
      expect(antes.map((p) => ({ engine: p.engine, row_version: p.row_version }))).toEqual([
        { engine: 'hermes', row_version: versao },
      ]);

      const upd = await tentarEscritaConcorrente(canal, versao, 'update');
      const del = await tentarEscritaConcorrente(canal, versao, 'delete');
      expect(upd).toMatchObject({ aplicou: false, rowCount: 0, code: '55P03' });
      expect(del).toMatchObject({ aplicou: false, rowCount: 0, code: '55P03' });

      // Depois das duas tentativas, a releitura do CAS dentro da MESMA
      // transação continua vendo o retrato que autorizou a ativação. É esse
      // retrato que o commit vai assinar.
      const depois = await loadEnginePolicyBindingsWith(tx, scope);
      expect(depois.map((p) => ({ engine: p.engine, row_version: p.row_version }))).toEqual([
        { engine: 'hermes', row_version: versao },
      ]);
      expect(engineBindingRevision(depois, scope)).toBe(engineBindingRevision(antes, scope));
    });

    // E o banco, fora da transação, está intacto.
    expect(
      await query<{ engine: string; row_version: number }>(
        `SELECT engine, row_version::int AS row_version
           FROM agent_engine_policies WHERE channel_id = $1`,
        [canal],
      ),
    ).toEqual([{ engine: 'hermes', row_version: versao }]);
  });

  it('2. SEM a trava (o defeito do QA): o UPDATE concorrente entra e o retrato MUDA sob a mesma tx', async () => {
    const { tenant, agent } = novoEscopo('a2');
    await mkIdentidades(tenant, agent);
    const canal = await mkCanal(tenant, agent);
    const versao = await mkPoliticaHermes(tenant, agent, canal);
    const scope = { tenant_id: tenant, agent_id: agent };

    await db.transaction(async (tx) => {
      // Só o retrato de readiness — é EXATAMENTE o estado pré-correção, em que
      // nada travava `agent_engine_policies`.
      await lockReadinessSnapshot(tx, scope);
      const antes = await loadEnginePolicyBindingsWith(tx, scope);

      const upd = await tentarEscritaConcorrente(canal, versao, 'update');
      expect(upd).toMatchObject({ aplicou: true, rowCount: 1, code: null });

      const depois = await loadEnginePolicyBindingsWith(tx, scope);
      expect(depois.map((p) => ({ engine: p.engine, row_version: p.row_version }))).toEqual([
        { engine: 'maia_react', row_version: versao + 1 },
      ]);
      // A deriva é o que o CAS compara: o token do retrato muda DENTRO da
      // transação que estava decidindo com o token antigo.
      expect(engineBindingRevision(depois, scope)).not.toBe(engineBindingRevision(antes, scope));
    });

    // Limpa a divergência para não contaminar vizinhos (o caso 1 usa o mesmo
    // formato de fixture, mas escopo próprio).
    await query('DELETE FROM agent_engine_policies WHERE channel_id = $1', [canal]);
  });

  it('3. na ativação REAL: a sonda concorrente é recusada dentro da tx e entra fora dela', async () => {
    const { startOnboardingRun, executeOnboardingStep } =
      await import('../../src/onboarding/wizard.js');
    const { tenant, agent, line } = novoEscopo('a3');
    const actor = { actor_id: `${PREFIX}-tester`, actor_role: 'owner' as const, tenant_id: tenant };

    const started = await startOnboardingRun({
      kind: 'tenant_onboarding',
      tenant_id: tenant,
      actor,
      idempotency_key: `${PREFIX}-start-${Date.now()}`,
    });
    if (started.status !== 'started') throw new Error(`run não abriu: ${started.code}`);
    const run = started.run;
    createdRuns.push(run.id);

    let version = run.version;
    const step = async (
      name: string,
      payload: unknown,
      deps?: Parameters<typeof executeOnboardingStep>[0]['deps'],
    ) => {
      const out = await executeOnboardingStep({
        run_id: run.id,
        step: name,
        payload,
        idempotency_key: `${PREFIX}-${name}`,
        expected_version: version,
        actor,
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

    await step('provision_tenant', { tenant_id: tenant, nome: `SC03 lock ${tenant}` });
    await step('provision_admin', {
      user_id: `${PREFIX}-admin-${tenant}`,
      email: `${tenant}@sc03-lock.test`,
      role: 'owner',
    });
    await step('provision_agent', { agent_id: agent, nome: `Bot ${tenant}` });
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
      display_name: `Linha ${tenant}`,
    });
    const channel_id = declared.result.channel_id as string;
    const versao = await mkPoliticaHermes(tenant, agent, channel_id);

    await step(
      'start_pairing',
      { channel_id, method: 'qr' },
      { requestPairing: async () => ({ ok: true }) },
    );
    // O worker do runtime é quem prova a posse; aqui simulamos o resultado.
    await query(`UPDATE channel_line_state SET state='connected' WHERE channel_id=$1`, [
      channel_id,
    ]);
    await step('confirm_channel_ready', { channel_id });

    /**
     * O ponto de sonda é a porta de EVIDÊNCIA: o avaliador a chama DEPOIS dos
     * locks (`lockReadinessSnapshot` + `lockEnginePolicyBindings`) e ANTES de
     * `applyActivate` — o mesmo instante em que o QA conseguiu escrever.
     */
    const sondas: Tentativa[] = [];
    const loadEngineEvidenceComSonda = async () => {
      sondas.push(await tentarEscritaConcorrente(channel_id, versao, 'update'));
      return evidenciaSintetica();
    };

    const readinessOut = await step('evaluate_readiness', {}, {
      loadEngineEvidence: async () => evidenciaSintetica(),
    });
    expect(readinessOut.readiness?.engine).toMatchObject({
      requested: true,
      available: true,
      unavailable_reason: null,
    });

    // (a) FORA de qualquer transação da ativação a MESMA escrita ENTRA: a
    // janela existe. O efeito é desfeito em seguida — o alvo deste caso é a
    // ATIVAÇÃO, e a linha tem de voltar ao retrato que o passo vai revalidar.
    const foraDaAtivacao = await tentarEscritaConcorrente(channel_id, versao, 'update');
    expect(foraDaAtivacao).toMatchObject({ aplicou: true, rowCount: 1, code: null });
    await query(
      `UPDATE agent_engine_policies SET engine = 'hermes', row_version = $2, updated_at = now()
        WHERE channel_id = $1`,
      [channel_id, versao],
    );

    // (b) DENTRO da ativação (reavaliação e revalidação CAS), a mesma escrita é
    // recusada pelo Postgres: a transação do passo segura o FOR SHARE.
    const ativado = await step(
      'activate',
      { confirm_tenant_id: tenant, confirm_agent_id: agent },
      { loadEngineEvidence: loadEngineEvidenceComSonda },
    );
    expect(ativado.run.state).toBe('active');
    expect(sondas).toHaveLength(2);
    expect(sondas.map((s) => s.code)).toEqual(['55P03', '55P03']);
    expect(sondas.every((s) => s.aplicou === false)).toBe(true);

    // A ativação terminou com o retrato INTACTO e o canal ligado.
    expect(
      await query<{ engine: string; row_version: number }>(
        `SELECT engine, row_version::int AS row_version
           FROM agent_engine_policies WHERE channel_id = $1`,
        [channel_id],
      ),
    ).toEqual([{ engine: 'hermes', row_version: versao }]);
    expect(await query<{ active: boolean }>('SELECT active FROM channels WHERE id=$1', [channel_id]))
      .toEqual([{ active: true }]);
  });
});