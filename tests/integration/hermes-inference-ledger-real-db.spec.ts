/**
 * P06 (spec Maia+Hermes §9.1, §9.2) — o LEDGER do gateway de inferência contra
 * Postgres REAL (migration 144) e o `inferenceRepo`.
 *
 * O que só o banco prova:
 *
 *  1. o grant guarda só a HASH do token, herda epoch e manifest do run, e é
 *     imutável exceto a revogação, que é monotônica;
 *  2. a admissão recusa sob o estado TRAVADO: revogação, fase, controle humano,
 *     epoch, prazo, modelo, superfície, teto de chamadas e orçamento;
 *  3. a reserva entra na conta ANTES do provider, e a liquidação a troca por
 *     custo, libera (não enviado) ou mantém como exposição (desconhecido);
 *  4. liquidar é idempotente e eventos de uso são append-only;
 *  5. escopo: grant de um tenant/agente não é visível de outro (cada eixo
 *     variando SOZINHO).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  hashInferenceToken,
} from '@/integrations/hermes/inference-credential.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = 'hermes144-tenant-a';
const G_A = 'hermes144-agent-a';
const T_B = 'hermes144-tenant-b';
const G_A2 = 'hermes144-agent-a2';

const SHA = 'a'.repeat(64);
const MODEL = 'anthropic/claude-sonnet-4.6';
const SURFACE = { fixture_echo: 'c'.repeat(64) };
const DENY = { on_unpriced: 'deny' as const };

let pool: pg.Pool;

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

type Run = { run_id: string; control_id: string; tenant: string; agent: string };

async function mkRun(
  tenant: string,
  agent: string,
  over: Partial<{ phase: string; deadline: string }> = {},
): Promise<Run> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, now())`,
    [mensagem_id, tenant, agent],
  );
  const turn_id = randomUUID();
  const claim = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, claim_token, attempt_count)
     VALUES ($1, $2, $3, $4, 'running', $5, 1)`,
    [turn_id, tenant, agent, mensagem_id, claim],
  );
  const control_id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [control_id, tenant, agent, `stream-${control_id}`, randomUUID()],
  );
  await pool.query(
    `INSERT INTO engine_turn_bindings (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest, protocol_version, max_generations)
     VALUES ($1, $2, $3, 'hermes', 'adapter-0.1.0', $4, 1, 3)`,
    [tenant, agent, turn_id, SHA],
  );
  const run_id = randomUUID();
  await pool.query(
    `INSERT INTO engine_runs (
       id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt, origin_claim_token,
       origin_worker_id, control_id, control_epoch, mode, manifest_digest, phase, request_key,
       remote_instance_id, request_json, request_hash, host_context_json,
       host_context_hash, deadline_at, reconcile_deadline_at)
     VALUES ($1,$2,$3,$4,1,1,$5,'worker-1',$6,0,'live',$7,$8,$9,'inst-1',
             '{"version":1}'::jsonb,$7,'{"version":1}'::jsonb,$7,
             now() + $10::interval, now() + interval '30 minutes')`,
    [
      run_id,
      tenant,
      agent,
      turn_id,
      claim,
      control_id,
      SHA,
      over.phase ?? 'running',
      randomUUID(),
      over.deadline ?? '5 minutes',
    ],
  );
  return { run_id, control_id, tenant, agent };
}

const as = <T>(r: { tenant: string; agent: string }, fn: () => Promise<T>) =>
  runWithTenantContext({ tenant_id: r.tenant, agent_id: r.agent }, fn);

async function today(): Promise<string> {
  const r = await pool.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`,
  );
  return r.rows[0]!.d;
}

/** Conta nova por teste: agente próprio, para os saldos não vazarem entre casos. */
async function freshAgent(tenant: string): Promise<string> {
  const agent = `hermes144-agent-${randomUUID().slice(0, 8)}`;
  await ensureTenantAgent(tenant, agent);
  return agent;
}

async function grantFor(run: Run, over: Partial<{ max_inference_calls: number }> = {}) {
  const res = await as(run, () =>
    inferenceRepo.issueGrant({
      run_id: run.run_id,
      audience: INFERENCE_GRANT_AUDIENCE,
      model: MODEL,
      tool_surface: SURFACE,
      max_inference_calls: over.max_inference_calls ?? 10,
      max_output_tokens: 1024,
      ttl_ms: 60_000,
    }),
  );
  if (!res.ok) throw new Error(`issueGrant: ${res.reason}`);
  return res;
}

function admit(
  run: Run,
  grant_id: string,
  over: Partial<{
    estimate: string | null;
    model: string;
    tools: string[];
    audience: string;
    policy: { on_unpriced: 'deny' | 'admit_unpriced' };
  }> = {},
) {
  return as(run, () =>
    inferenceRepo.admitAttempt({
      grant_id,
      attempt_id: randomUUID(),
      request_hash: SHA,
      provider: 'openrouter',
      presented_audience: over.audience ?? INFERENCE_GRANT_AUDIENCE,
      model_requested: over.model ?? MODEL,
      tool_names_requested: over.tools ?? ['fixture_echo'],
      estimate_microusd: over.estimate === undefined ? '1000' : over.estimate,
      tariff_version: 'tarifa-teste',
      policy: over.policy ?? DENY,
    }),
  );
}

async function conta(run: Run) {
  const r = await pool.query<{ reserved: string; settled: string }>(
    `SELECT reserved_microusd::text AS reserved, settled_microusd::text AS settled
       FROM engine_budget_accounts WHERE tenant_id = $1 AND agent_id = $2
        AND period_start_utc = (now() AT TIME ZONE 'UTC')::date`,
    [run.tenant, run.agent],
  );
  return r.rows[0];
}

async function expectPgError(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? '', message: e.message ?? '' };
  }
  throw new Error('esperava erro do Postgres, e a operação passou');
}

d('P06 — ledger do gateway de inferência (migration 144)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await ensureTenantAgent(T_A, G_A);
    await ensureTenantAgent(T_A, G_A2);
    await ensureTenantAgent(T_B, G_A.replace('agent-a', 'agent-b'));
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('grant', () => {
    it('guarda só a hash, herda epoch e manifest do run, e resolve pela hash', async () => {
      const run = await mkRun(T_A, G_A);
      const g = await grantFor(run);
      expect(g.token).toMatch(/^mhi1_/);

      const rows = await pool.query(
        `SELECT token_hash, control_epoch::text AS epoch, manifest_digest, row_to_json(g)::text AS raw
           FROM engine_inference_grants g WHERE id = $1`,
        [g.grant_id],
      );
      expect(rows.rows[0].token_hash).toBe(hashInferenceToken(g.token));
      expect(rows.rows[0].epoch).toBe('0');
      expect(rows.rows[0].manifest_digest).toBe(SHA);
      expect(rows.rows[0].raw).not.toContain(g.token);

      expect(await inferenceRepo.resolveGrantScope(hashInferenceToken(g.token))).toEqual({
        grant_id: g.grant_id,
        tenant_id: T_A,
        agent_id: G_A,
      });
      expect(await inferenceRepo.resolveGrantScope('f'.repeat(64))).toBeNull();
    });

    it('é imutável exceto a revogação, e a revogação é monotônica', async () => {
      const run = await mkRun(T_A, G_A);
      const g = await grantFor(run);
      const e1 = await expectPgError(() =>
        pool.query(`UPDATE engine_inference_grants SET model = 'outro' WHERE id = $1`, [g.grant_id]),
      );
      expect(e1.code).toBe('23001');
      await as(run, () => inferenceRepo.revokeGrantsForRun({ run_id: run.run_id, reason: 'teste' }));
      const e2 = await expectPgError(() =>
        pool.query(
          `UPDATE engine_inference_grants SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1`,
          [g.grant_id],
        ),
      );
      expect(e2.code).toBe('23001');
      const e3 = await expectPgError(() =>
        pool.query(`DELETE FROM engine_inference_grants WHERE id = $1`, [g.grant_id]),
      );
      expect(e3.code).toBe('23001');
    });

    it('run revogado ou fechado não ganha grant', async () => {
      const run = await mkRun(T_A, G_A);
      await pool.query(
        `UPDATE engine_runs SET capabilities_revoked_at = now() WHERE id = $1`,
        [run.run_id],
      );
      const res = await as(run, () =>
        inferenceRepo.issueGrant({
          run_id: run.run_id,
          audience: INFERENCE_GRANT_AUDIENCE,
          model: MODEL,
          tool_surface: SURFACE,
          max_inference_calls: 1,
          max_output_tokens: 1,
          ttl_ms: 60_000,
        }),
      );
      expect(res).toEqual({ ok: false, reason: 'run_revoked' });
    });

    it('escopo: o grant de outro tenant ou de outro agente não existe daqui', async () => {
      const run = await mkRun(T_A, G_A);
      const g = await grantFor(run);
      // Mesmo agente-id textual em OUTRO tenant não existe; mesmo tenant, outro agente.
      const outroAgente = await runWithTenantContext({ tenant_id: T_A, agent_id: G_A2 }, () =>
        inferenceRepo.loadGrantState(g.grant_id),
      );
      expect(outroAgente).toBeNull();
      const outroTenant = await runWithTenantContext(
        { tenant_id: T_B, agent_id: G_A.replace('agent-a', 'agent-b') },
        () => inferenceRepo.loadGrantState(g.grant_id),
      );
      expect(outroTenant).toBeNull();
      const meu = await as(run, () => inferenceRepo.loadGrantState(g.grant_id));
      expect(meu?.grant.allowed_tool_names).toEqual(['fixture_echo']);
      expect(meu?.control_ok).toBe(true);
    });
  });

  describe('admissão', () => {
    it('reserva ANTES do provider e numera as tentativas do run', async () => {
      const agent = await freshAgent(T_A);
      const run = await mkRun(T_A, agent);
      await as(run, async () =>
        inferenceRepo.openBudgetAccount({ period_start_utc: await today(), limit_microusd: '5000' }),
      );
      const g = await grantFor(run);
      const a1 = await admit(run, g.grant_id, { estimate: '1000' });
      const a2 = await admit(run, g.grant_id, { estimate: '1500' });
      expect(a1).toMatchObject({ ok: true, attempt_seq: 1, reserved_microusd: '1000' });
      expect(a2).toMatchObject({ ok: true, attempt_seq: 2, reserved_microusd: '1500' });
      expect(await conta(run)).toEqual({ reserved: '2500', settled: '0' });
    });

    it('recusas de orçamento: sem conta, sem preço (deny) e acima do limite', async () => {
      const agent = await freshAgent(T_A);
      const run = await mkRun(T_A, agent);
      const g = await grantFor(run);
      expect(await admit(run, g.grant_id)).toMatchObject({ ok: false, code: 'admission_unavailable' });
      await as(run, async () =>
        inferenceRepo.openBudgetAccount({ period_start_utc: await today(), limit_microusd: '1000' }),
      );
      expect(await admit(run, g.grant_id, { estimate: null })).toMatchObject({
        ok: false,
        code: 'budget_exhausted',
      });
      expect(await admit(run, g.grant_id, { estimate: '1001' })).toMatchObject({
        ok: false,
        code: 'budget_exhausted',
      });
      expect(await conta(run)).toEqual({ reserved: '0', settled: '0' });
      // admit_unpriced admite sem reservar (exposição sem teto, declarada).
      expect(
        await admit(run, g.grant_id, { estimate: null, policy: { on_unpriced: 'admit_unpriced' } }),
      ).toMatchObject({ ok: true, reserved_microusd: null });
    });

    it('recusas de autoridade sob o estado travado', async () => {
      const agent = await freshAgent(T_A);
      await as({ tenant: T_A, agent }, async () =>
        inferenceRepo.openBudgetAccount({ period_start_utc: await today(), limit_microusd: '100000' }),
      );

      const r1 = await mkRun(T_A, agent);
      const g1 = await grantFor(r1, { max_inference_calls: 1 });
      expect(await admit(r1, g1.grant_id, { audience: 'outro' })).toMatchObject({
        ok: false,
        code: 'invalid_inference_grant',
      });
      expect(await admit(r1, g1.grant_id, { model: 'outro/modelo' })).toMatchObject({
        ok: false,
        code: 'model_not_allowed',
      });
      expect(await admit(r1, g1.grant_id, { tools: ['terminal'] })).toMatchObject({
        ok: false,
        code: 'tool_surface_mismatch',
      });
      expect(await admit(r1, g1.grant_id)).toMatchObject({ ok: true });
      expect(await admit(r1, g1.grant_id)).toMatchObject({
        ok: false,
        code: 'inference_limit_exceeded',
      });

      const r2 = await mkRun(T_A, agent, { phase: 'submitting' });
      const g2 = await grantFor(r2);
      expect(await admit(r2, g2.grant_id)).toMatchObject({ ok: false, code: 'run_not_active' });

      const r3 = await mkRun(T_A, agent);
      const g3 = await grantFor(r3);
      await pool.query(`UPDATE engine_runs SET capabilities_revoked_at = now() WHERE id = $1`, [
        r3.run_id,
      ]);
      expect(await admit(r3, g3.grant_id)).toMatchObject({ ok: false, code: 'run_revoked' });

      const r4 = await mkRun(T_A, agent);
      const g4 = await grantFor(r4);
      await pool.query(
        `UPDATE conversation_controls
            SET mode = 'human', owner_app_user_id = 'op-1', paused_at = now(), control_epoch = 1
          WHERE id = $1`,
        [r4.control_id],
      );
      expect(await admit(r4, g4.grant_id)).toMatchObject({
        ok: false,
        code: 'run_revoked',
        audit_reason: 'control_changed',
      });

      const r5 = await mkRun(T_A, agent);
      const g5 = await grantFor(r5);
      await as(r5, () => inferenceRepo.revokeGrantsForRun({ run_id: r5.run_id, reason: 'x' }));
      expect(await admit(r5, g5.grant_id)).toMatchObject({ ok: false, code: 'run_revoked' });

      const r6 = await mkRun(T_A, agent, { deadline: '1 second' });
      const g6 = await grantFor(r6);
      await new Promise((r) => setTimeout(r, 1_200));
      expect(await admit(r6, g6.grant_id)).toMatchObject({
        ok: false,
        code: 'run_not_active',
        audit_reason: 'deadline_passed',
      });
    });
  });

  describe('liquidação', () => {
    async function setup(limit = '100000') {
      const agent = await freshAgent(T_A);
      const run = await mkRun(T_A, agent);
      await as(run, async () =>
        inferenceRepo.openBudgetAccount({ period_start_utc: await today(), limit_microusd: limit }),
      );
      const g = await grantFor(run);
      return { run, g };
    }

    it('não enviado libera a reserva', async () => {
      const { run, g } = await setup();
      const a = await admit(run, g.grant_id, { estimate: '700' });
      if (!a.ok) throw new Error(a.code);
      const s = await as(run, () =>
        inferenceRepo.settleAttempt({
          attempt_id: a.attempt_id,
          outcome: { kind: 'not_sent', error_code: 'configuration' },
        }),
      );
      expect(s).toEqual({ ok: true, already: false, accounting_status: 'settled' });
      expect(await conta(run)).toEqual({ reserved: '0', settled: '0' });
    });

    it('custo conhecido troca reserva por liquidado e grava UM evento; repetir não duplica', async () => {
      const { run, g } = await setup();
      const a = await admit(run, g.grant_id, { estimate: '900' });
      if (!a.ok) throw new Error(a.code);
      const outcome = {
        kind: 'completed' as const,
        prompt_tokens: 100,
        completion_tokens: 20,
        cost_microusd: '640',
        source: 'gateway_estimated' as const,
      };
      await as(run, () => inferenceRepo.settleAttempt({ attempt_id: a.attempt_id, outcome }));
      const again = await as(run, () =>
        inferenceRepo.settleAttempt({ attempt_id: a.attempt_id, outcome }),
      );
      expect(again).toMatchObject({ ok: true, already: true });
      expect(await conta(run)).toEqual({ reserved: '0', settled: '640' });
      const ev = await pool.query(
        `SELECT kind, source, delta_microusd::text AS delta FROM engine_usage_events WHERE attempt_id = $1`,
        [a.attempt_id],
      );
      expect(ev.rows).toEqual([{ kind: 'reported', source: 'gateway_estimated', delta: '640' }]);
    });

    it('custo desconhecido não é zero: a reserva continua como exposição', async () => {
      const { run, g } = await setup();
      const a = await admit(run, g.grant_id, { estimate: '800' });
      const b = await admit(run, g.grant_id, { estimate: '300' });
      if (!a.ok || !b.ok) throw new Error('admissão');
      await as(run, () =>
        inferenceRepo.settleAttempt({
          attempt_id: a.attempt_id,
          outcome: {
            kind: 'completed',
            prompt_tokens: null,
            completion_tokens: null,
            cost_microusd: null,
            source: 'unavailable',
          },
        }),
      );
      await as(run, () =>
        inferenceRepo.settleAttempt({
          attempt_id: b.attempt_id,
          outcome: { kind: 'failed_after_send', error_code: 'timeout' },
        }),
      );
      expect(await conta(run)).toEqual({ reserved: '1100', settled: '0' });
      const st = await pool.query(
        `SELECT state, accounting_status, settled_microusd FROM engine_inference_attempts
          WHERE id = ANY($1::uuid[]) ORDER BY attempt_seq`,
        [[a.attempt_id, b.attempt_id]],
      );
      expect(st.rows).toEqual([
        { state: 'completed', accounting_status: 'unknown', settled_microusd: null },
        { state: 'failed_after_send', accounting_status: 'unknown', settled_microusd: null },
      ]);
      const ev = await pool.query(
        `SELECT delta_microusd FROM engine_usage_events WHERE attempt_id = $1`,
        [a.attempt_id],
      );
      expect(ev.rows).toEqual([{ delta_microusd: null }]);
    });

    it('eventos de uso são append-only', async () => {
      const { run, g } = await setup();
      const a = await admit(run, g.grant_id);
      if (!a.ok) throw new Error(a.code);
      await as(run, () =>
        inferenceRepo.settleAttempt({
          attempt_id: a.attempt_id,
          outcome: { kind: 'failed_after_send', error_code: 'timeout' },
        }),
      );
      const e = await expectPgError(() =>
        pool.query(`UPDATE engine_usage_events SET delta_microusd = 0 WHERE attempt_id = $1`, [
          a.attempt_id,
        ]),
      );
      expect(e.code).toBe('23001');
    });
  });
});
