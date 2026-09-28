/**
 * SC25-A — grant relay restrito e captura SDK pinado (D09) contra Postgres REAL.
 *
 * ─── O que este arquivo prova, e contra o quê ──────────────────────────────
 *
 * A rota `POST /internal/hermes-inference/v1/chat/completions` é exercitada com
 * o `inferenceRepo` REAL (migration 144), o relay REAL e um provider STUB de
 * loopback. O que só o banco prova:
 *
 *  1. o grant guardado só pela HASH do token, com epoch/manifest herdados do
 *     run, imutável exceto por revogação monotônica (AC01);
 *  2. T18 — canal inválido, credencial ausente, audience errada e grant
 *     expirado colapsam numa recusa AUTENTICADA e SANITIZADA, sem linha de
 *     tentativa e sem consulta business (a política não tem por onde expressar
 *     pessoa/conversa/canal);
 *  3. cada request efetivo — inclusive a REPETIÇÃO que o SDK pinado faz depois
 *     de um 503 — passa por schema fechado e admissão ANTES do provider, e o
 *     envelope recusa corpo/modelo/tools divergentes (AC02, AC05, AC06);
 *  4. sem preço a admissão RECUSA (default deny, 429 terminal), o uso ausente
 *     vira `unknown` e o desconhecido NÃO é zerado; reserva esgotada bloqueia
 *     antes do provider (AC03, AC07, SPEC-L1797);
 *  5. o relay é privado, textual e de URL FIXA: redirect não é seguido,
 *     conteúdo não textual e rota alternativa não existem (AC07).
 *
 * ─── Tier dos doubles, declarado ───────────────────────────────────────────
 *
 * O provider é stub de loopback (não é modelo). O cliente de inferência é o
 * `AIAgent` REAL do checkout pinado quando `MAIA_HERMES_WORKER_PYTHON`/
 * `MAIA_HERMES_UPSTREAM` estão presentes; sem eles, o cenário ponta a ponta
 * PULA e aparece como pulado no relatório. Nenhuma alegria de integração com
 * doubles é reportada: os cenários de ledger usam o repositório real e leem
 * rows; os cenários que usam double dizem QUAL fronteira foi dobrada.
 *
 * Skipped sem `TEST_DB_URL` (padrão das fatias de DB real).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  hashInferenceToken,
  mintInferenceToken,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';
import {
  INFERENCE_GATEWAY_BASE_PATH,
  INFERENCE_GATEWAY_COMPLETIONS_PATH,
  validateInferenceGrant,
} from '@/integrations/hermes/inference-gateway.js';
import { registerHermesInferenceRoute } from '@/integrations/hermes/inference-route.js';
import type { StartFrame } from '@/integrations/hermes/protocol.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const PINS = !!(PYTHON && UPSTREAM);

const HERMES_SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const MODEL = 'maia-stub-model';
const MANIFEST = 'a'.repeat(64);
const SURFACE = toolSurfaceOf(
  [
    {
      name: 'fixture_echo',
      input_schema: {
        type: 'object',
        description: 'Ecoa o texto.',
        properties: { texto: { type: 'string' } },
        required: ['texto'],
        additionalProperties: false,
      },
    },
  ],
  MODEL,
);

const TARIFF = { version: 'tarifa-sc25a', input_nanousd_per_token: 1000, output_nanousd_per_token: 1000 };

let pool: pg.Pool;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

// ─── fixture de domínio (mesma forma do spec do ledger 144) ─────────────────

type Run = { run_id: string; control_id: string; turn_id: string; tenant: string; agent: string };

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [tenant]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

/** Tenant/agente NOVOS por cenário: conta de orçamento e grant não vazam. */
async function novoEscopo(): Promise<{ tenant: string; agent: string }> {
  const sufixo = randomUUID().slice(0, 8);
  const tenant = `sc25a-tenant-${sufixo}`;
  const agent = `sc25a-agent-${sufixo}`;
  await ensureTenantAgent(tenant, agent);
  return { tenant, agent };
}

async function mkRun(
  tenant: string,
  agent: string,
  over: Partial<{ phase: string; deadline: string; manifest_digest: string }> = {},
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
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, claim_token,
                              attempt_count, claimed_by, lease_expires_at)
     VALUES ($1, $2, $3, $4, 'running', $5, 1, 'worker-1', now() + interval '10 minutes')`,
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
    [tenant, agent, turn_id, MANIFEST],
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
      over.manifest_digest ?? MANIFEST,
      over.phase ?? 'running',
      randomUUID(),
      over.deadline ?? '5 minutes',
    ],
  );
  return { run_id, control_id, turn_id, tenant, agent };
}

const as = <T>(r: { tenant: string; agent: string }, fn: () => Promise<T>) =>
  runWithTenantContext({ tenant_id: r.tenant, agent_id: r.agent }, fn);

async function today(): Promise<string> {
  const r = await pool.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`);
  return r.rows[0]!.d;
}

async function abrirConta(run: Run, limit = '1000000000'): Promise<void> {
  const res = await as(run, async () =>
    inferenceRepo.openBudgetAccount({ period_start_utc: await today(), limit_microusd: limit }),
  );
  expect(res.account_id).toBeTruthy();
}

async function emitirGrant(
  run: Run,
  over: Partial<{ audience: string; model: string; tool_surface: Record<string, string>; max_calls: number }> = {},
) {
  const res = await as(run, () =>
    inferenceRepo.issueGrant({
      run_id: run.run_id,
      audience: over.audience ?? INFERENCE_GRANT_AUDIENCE,
      model: over.model ?? MODEL,
      tool_surface: over.tool_surface ?? SURFACE,
      max_inference_calls: over.max_calls ?? 10,
      max_output_tokens: 256,
      ttl_ms: 60_000,
    }),
  );
  if (!res.ok) throw new Error(`issueGrant: ${res.reason}`);
  return res;
}

async function tentativas(run: Run) {
  const r = await pool.query<{
    attempt_seq: number;
    state: string;
    accounting_status: string;
    reserved_microusd: string | null;
    settled_microusd: string | null;
    last_error_code: string | null;
    model: string;
  }>(
    `SELECT attempt_seq, state, accounting_status, reserved_microusd::text AS reserved_microusd,
            settled_microusd::text AS settled_microusd, last_error_code, model
       FROM engine_inference_attempts
      WHERE tenant_id = $1 AND agent_id = $2 AND run_id = $3
      ORDER BY attempt_seq`,
    [run.tenant, run.agent, run.run_id],
  );
  return r.rows;
}

async function contaOrcamento(run: Run) {
  const r = await pool.query<{ limit_microusd: string; reserved: string; settled: string }>(
    `SELECT limit_microusd::text AS limit_microusd, reserved_microusd::text AS reserved,
            settled_microusd::text AS settled
       FROM engine_budget_accounts
      WHERE tenant_id = $1 AND agent_id = $2 AND period_start_utc = (now() AT TIME ZONE 'UTC')::date`,
    [run.tenant, run.agent],
  );
  return r.rows[0];
}

// ─── gateway real sobre o repositório real ─────────────────────────────────

type GatewayOpts = {
  relay?: ReturnType<typeof createChatCompletionsRelay>;
  tariff?: typeof TARIFF | null;
  /** Dobra DECLARADA: substitui o relay real só no cenário que a nomeia. */
  relayDouble?: ReturnType<typeof createChatCompletionsRelay>;
};

async function subirGateway(opts: GatewayOpts = {}) {
  const app: FastifyInstance = Fastify();
  cleanup.push(() => app.close());
  const relay = opts.relayDouble ?? opts.relay;
  await registerHermesInferenceRoute(app, {
    ledger: inferenceRepo,
    relay: relay ?? null,
    tariffFor: async () => (opts.tariff === undefined ? TARIFF : opts.tariff),
    runInScope: (scope, fn) =>
      runWithTenantContext({ tenant_id: scope.tenant_id, agent_id: scope.agent_id }, fn),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}` };
}

type Resposta = { status: number; body: Record<string, unknown>; headers: Headers };

async function postar(
  base: string,
  token: string | null,
  body: unknown,
  path = INFERENCE_GATEWAY_COMPLETIONS_PATH,
): Promise<Resposta> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function codigo(res: Resposta): string | undefined {
  const erro = res.body.error as { code?: string; message?: string } | undefined;
  return erro?.code;
}

const corpo = (over: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [{ role: 'user', content: 'oi' }],
  max_tokens: 64,
  ...over,
});

d('SC25-A — grant relay restrito e captura SDK pinado (DB real)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  // ═══ AC01 — o grant é do host, guardado pela hash, revogável num sentido ═══

  it('AC01 — grant por run/epoch/audience/model/manifest/deadline; token só existe em memória', async () => {
    const escopo = await novoEscopo();
    const run = await mkRun(escopo.tenant, escopo.agent);
    const grant = await emitirGrant(run);

    const row = await pool.query<{
      token_hash: string;
      audience: string;
      model: string;
      control_epoch: string;
      manifest_digest: string;
      expires_at: string;
      created_at: string;
      revoked_at: string | null;
      max_output_tokens: number;
      tool_surface: Record<string, string>;
    }>(
      `SELECT token_hash, audience, model, control_epoch::text AS control_epoch, manifest_digest,
              expires_at, created_at, revoked_at, max_output_tokens, tool_surface
         FROM engine_inference_grants WHERE id = $1`,
      [grant.grant_id],
    );
    const g = row.rows[0]!;
    // A credencial só existe em memória: o banco guarda a hash.
    expect(g.token_hash).toBe(createHash('sha256').update(grant.token, 'utf8').digest('hex'));
    expect(g.token_hash).toBe(hashInferenceToken(grant.token));
    expect(g.token_hash).not.toContain(grant.token);
    // Herdados do RUN, não escolhidos por quem chama.
    expect(g.audience).toBe(INFERENCE_GRANT_AUDIENCE);
    expect(g.model).toBe(MODEL);
    expect(g.control_epoch).toBe('0');
    expect(g.manifest_digest).toBe(MANIFEST);
    expect(g.tool_surface).toEqual(SURFACE);
    expect(Date.parse(g.expires_at)).toBeGreaterThan(Date.parse(g.created_at));
    expect(g.revoked_at).toBeNull();

    // O TEXTO do token não está em NENHUMA coluna de texto do ledger.
    const vazamento = await pool.query<{ total: string }>(
      `SELECT (
          (SELECT count(*) FROM engine_inference_grants WHERE token_hash LIKE '%' || $1 || '%') +
          (SELECT count(*) FROM engine_inference_attempts WHERE request_hash LIKE '%' || $1 || '%') +
          (SELECT count(*) FROM engine_budget_accounts WHERE tenant_id || agent_id LIKE '%' || $1 || '%')
        )::text AS total`,
      [grant.token],
    );
    expect(vazamento.rows[0]!.total).toBe('0');

    // Revogação: monotônica, e o UPDATE que tentasse desfazer sobe do banco.
    const rev = await as(run, () =>
      inferenceRepo.revokeGrantsForRun({ run_id: run.run_id, reason: 'sc25a_teste' }),
    );
    expect(rev.revoked).toBeGreaterThan(0);
    const negado = await pool
      .query(`UPDATE engine_inference_grants SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1`, [
        grant.grant_id,
      ])
      .then(
        () => null,
        (err: { code?: string; message?: string }) => err,
      );
    expect(negado).not.toBeNull();
    expect(negado!.code).toBe('23001');
    const ainda = await pool.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM engine_inference_grants WHERE id = $1`,
      [grant.grant_id],
    );
    expect(ainda.rows[0]!.revoked_at).not.toBeNull();
  });

  // ═══ T18 — recusa autenticada sanitizada, sem consulta business ═══════════

  it('T18 — canal inválido/credencial ausente/audience errada recusam 401 sanitizado, sem linha de tentativa', async () => {
    const escopo = await novoEscopo();
    const run = await mkRun(escopo.tenant, escopo.agent);
    await abrirConta(run);
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'nunca chamado' }] });
    cleanup.push(() => stub.close());
    const gw = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stub.baseUrl }),
    });

    // 1. credencial AUSENTE.
    const semCredencial = await postar(gw.base, null, corpo());
    expect(semCredencial.status).toBe(401);
    expect(codigo(semCredencial)).toBe('invalid_inference_grant');
    // 2. credencial com forma válida e grant inexistente.
    const desconhecida = await postar(gw.base, mintInferenceToken(), corpo());
    expect(desconhecida.status).toBe(401);
    expect(codigo(desconhecida)).toBe('invalid_inference_grant');
    // 3. AUDIENCE errada: o grant foi emitido para outro público.
    const outroPublico = await emitirGrant(run, { audience: 'maia.hermes.tools.v1' });
    const audienceErrada = await postar(gw.base, outroPublico.token, corpo());
    expect(audienceErrada.status).toBe(401);
    expect(codigo(audienceErrada)).toBe('invalid_inference_grant');

    // As três recusas são INDISTINGUÍVEIS no fio e não citam run/tenant/modelo.
    for (const r of [semCredencial, desconhecida, audienceErrada]) {
      const texto = JSON.stringify(r.body);
      expect(texto).not.toContain(escopo.tenant);
      expect(texto).not.toContain(escopo.agent);
      expect(texto).not.toContain(MODEL);
      expect(texto).not.toContain(run.run_id);
      expect(r.headers.get('x-should-retry')).toBe('false');
    }

    // Nenhuma consulta business e nenhuma tentativa: o provider não foi tocado.
    expect(await tentativas(run)).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);

    // Expirado/prazo vencido e ausência são decididos pela POLÍTICA real, com o
    // mesmo código de fio; o motivo interno é auditável e distinto.
    const expirado = validateInferenceGrant(
      {
        run_id: run.run_id,
        tenant_id: escopo.tenant,
        agent_id: escopo.agent,
        control_epoch: '0',
        audience: INFERENCE_GRANT_AUDIENCE,
        model: MODEL,
        manifest_digest: MANIFEST,
        allowed_tool_names: [],
        expires_at: new Date(Date.now() - 1_000).toISOString(),
        revoked_at: null,
        max_inference_calls: 10,
      },
      {
        presented_audience: INFERENCE_GRANT_AUDIENCE,
        now: new Date().toISOString(),
        run_phase: 'running',
        calls_so_far: 0,
        model_requested: MODEL,
        manifest_digest_effective: MANIFEST,
        tool_names_requested: [],
      },
    );
    expect(expirado).toEqual({
      kind: 'refused',
      code: 'invalid_inference_grant',
      audit_reason: 'expired',
    });
  });

  // ═══ AC05 + AC02 — autoridade vem do grant, não do corpo ═════════════════

  it('AC05/AC02 — corpo de autoridade, modelo divergente e tool fora do manifest recusam ANTES do provider', async () => {
    const escopo = await novoEscopo();
    const run = await mkRun(escopo.tenant, escopo.agent);
    await abrirConta(run);
    const grant = await emitirGrant(run);
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'ok' }] });
    cleanup.push(() => stub.close());
    const gw = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stub.baseUrl }),
    });

    // Campos que tentam escolher tenant/sessão/autoridade: 400 e nada de reserva.
    for (const campo of ['user', 'metadata', 'session_id', 'tenant_id']) {
      const r = await postar(gw.base, grant.token, corpo({ [campo]: 'x' }));
      expect(r.status, `campo ${campo}`).toBe(400);
      expect(codigo(r)).toBe('unsupported_parameter');
    }
    // Modelo divergente do aprovado.
    const outroModelo = await postar(gw.base, grant.token, corpo({ model: 'outro/modelo' }));
    expect(outroModelo.status).toBe(403);
    expect(codigo(outroModelo)).toBe('model_not_allowed');
    // Tool que não está na superfície normalizada do manifest.
    const toolExtra = await postar(
      gw.base,
      grant.token,
      corpo({
        tools: [
          {
            type: 'function',
            function: { name: 'tool_de_outro_agente', parameters: { type: 'object' } },
          },
        ],
      }),
    );
    expect(toolExtra.status).toBe(403);
    expect(codigo(toolExtra)).toBe('tool_surface_mismatch');
    // Parâmetro desconhecido e conteúdo não textual (imagem) também recusam.
    expect((await postar(gw.base, grant.token, corpo({ response_format: {} }))).status).toBe(400);
    const imagem = await postar(
      gw.base,
      grant.token,
      corpo({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x/y' } }] }] }),
    );
    expect(imagem.status).toBe(400);
    expect(codigo(imagem)).toBe('invalid_request');
    // Rota alternativa do SDK não existe: só a de completions é registrada.
    const alternativa = await postar(gw.base, grant.token, corpo(), `${INFERENCE_GATEWAY_BASE_PATH}/responses`);
    expect(alternativa.status).toBe(404);

    // NADA saiu para o provider e NENHUMA tentativa foi criada.
    expect(stub.requests).toHaveLength(0);
    expect(await tentativas(run)).toHaveLength(0);
    const conta = await contaOrcamento(run);
    expect(conta!.reserved).toBe('0');
  });

  // ═══ AC03 + AC07 + SPEC-L1797 — default deny, unknown e derivação de custo ═

  it('SPEC-L1797 — sem preço a admissão RECUSA antes do provider; uso ausente vira unknown (não zero)', async () => {
    const escopo = await novoEscopo();
    const run = await mkRun(escopo.tenant, escopo.agent);
    await abrirConta(run);
    const grant = await emitirGrant(run);
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'não deveria sair' }] });
    cleanup.push(() => stub.close());

    // (1) default deny: sem tarifa para o modelo, o provider NÃO é chamado.
    const semPreco = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stub.baseUrl }),
      tariff: null,
    });
    const recusado = await postar(semPreco.base, grant.token, corpo());
    expect(recusado.status).toBe(429);
    expect(codigo(recusado)).toBe('budget_exhausted');
    expect(stub.requests).toHaveLength(0);
    expect(await tentativas(run)).toHaveLength(0);
    // A recusa de cota deixa trilha durável (auditoria na MESMA transação).
    const auditada = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM audit_log
        WHERE acao = 'engine_quota_denied' AND alvo_id = $1`,
      [grant.grant_id],
    );
    expect(auditada.rows[0]!.total).toBe('1');

    // (2) reserva esgotada bloqueia antes do provider: limite de 1 microusd.
    const escopo2 = await novoEscopo();
    const run2 = await mkRun(escopo2.tenant, escopo2.agent);
    await abrirConta(run2, '1');
    const grant2 = await emitirGrant(run2);
    const gw2 = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stub.baseUrl }),
    });
    const estourado = await postar(gw2.base, grant2.token, corpo());
    expect(estourado.status).toBe(429);
    expect(codigo(estourado)).toBe('budget_exhausted');
    expect(stub.requests).toHaveLength(0);
    expect(await tentativas(run2)).toHaveLength(0);

    // (3) USO AUSENTE: o provider responde sem `usage` — o custo é desconhecido,
    // nunca zero. Dobra declarada na fronteira do relay (sem rede).
    const escopo3 = await novoEscopo();
    const run3 = await mkRun(escopo3.tenant, escopo3.agent);
    await abrirConta(run3);
    const grant3 = await emitirGrant(run3);
    const semUso = await subirGateway({
      relayDouble: {
        provider: 'stub-dobra',
        relay: async () => ({
          kind: 'ok',
          raw: {
            id: 'cmpl-sem-uso',
            object: 'chat.completion',
            created: 1_760_000_000,
            model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'oi' }, finish_reason: 'stop' }],
          },
        }),
      },
    });
    const resposta = await postar(semUso.base, grant3.token, corpo());
    expect(resposta.status).toBe(200);
    const [t3] = await tentativas(run3);
    expect(t3).toMatchObject({ state: 'completed', accounting_status: 'unknown', settled_microusd: null });
    // A reserva continua como EXPOSIÇÃO: desconhecido não é zero nem liberação.
    const conta3 = await contaOrcamento(run3);
    expect(Number(conta3!.reserved)).toBeGreaterThan(0);
    expect(conta3!.settled).toBe('0');
    // O evento de uso é `unavailable` com delta NULL.
    const evento = await pool.query<{ source: string; delta: string | null }>(
      `SELECT source, delta_microusd::text AS delta FROM engine_usage_events
        WHERE tenant_id = $1 AND agent_id = $2 AND run_id = $3`,
      [run3.tenant, run3.agent, run3.run_id],
    );
    expect(evento.rows).toEqual([{ source: 'unavailable', delta: null }]);

    // (4) desconhecido após envio: 5xx do provider ⇒ failed_after_send, e a
    // liquidação é idempotente (segunda chamada não duplica efeito).
    const escopo4 = await novoEscopo();
    const run4 = await mkRun(escopo4.tenant, escopo4.agent);
    await abrirConta(run4);
    const grant4 = await emitirGrant(run4);
    const stubFalha = await startStubProvider({
      script: [{ kind: 'error', status: 500, body: { error: { message: 'falha', type: 'server_error' } } }],
    });
    cleanup.push(() => stubFalha.close());
    const gw4 = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stubFalha.baseUrl }),
    });
    const falhou = await postar(gw4.base, grant4.token, corpo());
    expect(falhou.status).toBe(503);
    expect(codigo(falhou)).toBe('provider_unavailable');
    expect(stubFalha.requests).toHaveLength(1);
    const [t4] = await tentativas(run4);
    expect(t4).toMatchObject({ state: 'failed_after_send', accounting_status: 'unknown' });
    expect(t4!.last_error_code).toBe('provider_5xx');
    const repetido = await as(run4, async () =>
      inferenceRepo.settleAttempt({
        attempt_id: (
          await pool.query<{ id: string }>(
            `SELECT id FROM engine_inference_attempts WHERE tenant_id = $1 AND agent_id = $2 AND run_id = $3`,
            [run4.tenant, run4.agent, run4.run_id],
          )
        ).rows[0]!.id,
        outcome: { kind: 'failed_after_send', error_code: 'provider_5xx' },
      }),
    );
    expect(repetido).toMatchObject({ ok: true, already: true });
    const eventos4 = await pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM engine_usage_events
        WHERE tenant_id = $1 AND agent_id = $2 AND run_id = $3`,
      [run4.tenant, run4.agent, run4.run_id],
    );
    expect(eventos4.rows[0]!.total).toBe('1');
  });

  // ═══ AC07 — relay privado, textual e de URL fixa ═════════════════════════

  it('AC07 — redirect NÃO é seguido e o texto vira `stream:false` no egresso', async () => {
    const escopo = await novoEscopo();
    const run = await mkRun(escopo.tenant, escopo.agent);
    await abrirConta(run);
    const grant = await emitirGrant(run);
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'ok' }] });
    cleanup.push(() => stub.close());
    const gw = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: stub.baseUrl }),
    });

    // O cliente do filho STREAMA; o provider é chamado com stream=false.
    const ok = await postar(gw.base, grant.token, corpo({ stream: true, stream_options: { include_usage: true } }));
    expect(ok.status).toBe(200);
    const up = stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
    expect(up).toHaveLength(1);
    expect(up[0]!.body.stream).toBe(false);
    expect(up[0]!.body).not.toHaveProperty('stream_options');
    // A credencial do RUN nunca chegou ao provider.
    expect(JSON.stringify(stub.requests)).not.toContain(grant.token);
    const [t] = await tentativas(run);
    expect(t).toMatchObject({ state: 'completed', accounting_status: 'settled' });

    // Redirect: o stub responde 302 para outro host e o relay NÃO segue.
    const escopo2 = await novoEscopo();
    const run2 = await mkRun(escopo2.tenant, escopo2.agent);
    await abrirConta(run2);
    const grant2 = await emitirGrant(run2);
    const redirecionador = await startStubProvider({
      script: [
        {
          kind: 'error',
          status: 302,
          body: { error: { message: 'redireciona', type: 'redirect' } },
        },
      ],
    });
    cleanup.push(() => redirecionador.close());
    const gw2 = await subirGateway({
      relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'k', baseURL: redirecionador.baseUrl }),
    });
    const redirecionado = await postar(gw2.base, grant2.token, corpo());
    expect(redirecionado.status).toBe(503);
    expect(codigo(redirecionado)).toBe('provider_unavailable');
    // Sem segunda tentativa escondida e sem segundo host: UMA chamada, que saiu.
    expect(redirecionador.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(1);
    const [t2] = await tentativas(run2);
    expect(t2).toMatchObject({ state: 'failed_after_send', accounting_status: 'unknown' });
  });

  // ═══ AC06/AC02/D09 — o cliente PINADO contra relay+stub com ledger real ══

  (PINS ? describe : describe.skip)('cliente Hermes pinado (AIAgent real do SHA 5d59366)', () => {
    const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-sc25a-'));
    afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

    type Frame = Record<string, unknown>;
    const NL = String.fromCharCode(10);

    function spawnWorker(token: string) {
      const home = mkdtempSync(join(HOME_ROOT, 'home-'));
      const child = spawn(PYTHON as string, ['-m', 'services.hermes_worker.main'], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '',
          PYTHONPATH: `${UPSTREAM}:${process.cwd()}`,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          HERMES_HOME: home,
          MAIA_HERMES_SHA: HERMES_SHA,
          MAIA_HERMES_INFERENCE_KEY: token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }) as ChildProcessWithoutNullStreams;
      cleanup.push(async () => {
        if (child.exitCode === null) child.kill();
      });
      const frames: Frame[] = [];
      let erros = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (erros += c));
      const waiting: Array<{ type: string; resolve: (f: Frame) => void }> = [];
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf(NL);
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            const f = JSON.parse(line) as Frame;
            frames.push(f);
            const i = waiting.findIndex((w) => w.type === f.type);
            if (i >= 0) waiting.splice(i, 1)[0]!.resolve(f);
          }
          nl = buf.indexOf(NL);
        }
      });
      child.stderr.resume();
      return {
        frames,
        erros: () => erros,
        send: (f: Frame) => child.stdin.write(JSON.stringify(f) + NL),
        waitFor: (type: string) =>
          new Promise<Frame>((res, rej) => {
            const found = frames.find((f) => f.type === type);
            if (found) return res(found);
            const t = setTimeout(() => rej(new Error(`timeout esperando ${type}`)), 150_000);
            waiting.push({ type, resolve: (f) => (clearTimeout(t), res(f)) });
          }),
        exit: () =>
          new Promise<number | null>((res) => {
            if (child.exitCode !== null) return res(child.exitCode);
            child.on('exit', (c) => res(c));
          }),
      };
    }

    function startFrame(base_url: string): StartFrame {
      const run_id = randomUUID();
      return {
        protocol: 'maia.hermes.worker.v1',
        type: 'start',
        run_id,
        request_key: randomUUID(),
        binding: {
          execution_id: run_id,
          task_id: `task-${run_id}`,
          initial_session_id: `sess-${run_id}`,
          manifest_digest: MANIFEST,
          mode: 'live',
        },
        manifest: {
          schema: 'maia-hermes-runtime-manifest/v1',
          tools: [
            {
              name: 'fixture_echo',
              input_schema: {
                type: 'object',
                description: 'Ecoa o texto.',
                properties: { texto: { type: 'string' } },
                required: ['texto'],
                additionalProperties: false,
              },
              result_limit_chars: 4096,
            },
          ] as StartFrame['manifest']['tools'],
          result_limit_chars: 4096,
        },
        context: {
          system: 'Você é um atendente de teste. Responda curto.',
          user_message: '<user_message>diga oi</user_message>',
          history: [],
        },
        limits: {
          max_iterations: 4,
          max_output_tokens_per_call: 256,
          max_tool_calls: 2,
          max_inference_calls: 8,
          run_budget_seconds: 180,
          deadline_at: new Date(Date.now() + 180_000).toISOString(),
        },
        inference: { base_url, model: MODEL, provider: 'openai', api_mode: 'chat_completions' },
      };
    }

    it('AC02/AC06 — principal, retry e follow-up: cada HTTP admitido antes do provider e contado no ledger', async () => {
      const escopo = await novoEscopo();
      const run = await mkRun(escopo.tenant, escopo.agent);
      await abrirConta(run);
      const grant = await emitirGrant(run, { max_calls: 8 });
      const stub = await startStubProvider({
        script: [
          // 1ª chamada: provider 5xx ⇒ gateway 503 ⇒ o SDK pinado REPETE.
          { kind: 'error', status: 500, body: { error: { message: 'falha injetada', type: 'server_error' } } },
          { kind: 'tool_calls', calls: [{ name: 'fixture_echo', arguments: { texto: 'eco' } }] },
          { kind: 'text', content: 'eco respondido' },
        ],
      });
      cleanup.push(() => stub.close());
      const gw = await subirGateway({
        relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'chave-provider-stub', baseURL: stub.baseUrl }),
      });

      const worker = spawnWorker(grant.token);
      const start = startFrame(`${gw.base}${INFERENCE_GATEWAY_BASE_PATH}`);
      const diag = async (etapa: string): Promise<string> => {
        const t = await tentativas(run);
        return JSON.stringify({
          etapa,
          frames: worker.frames.map((f) => f.type),
          tentativas: t.map((l) => [l.attempt_seq, l.state, l.accounting_status, l.last_error_code]),
          stub: stub.requests.map((r) => [r.path, r.body.stream]),
          stderr: worker.erros().slice(-800),
        });
      };
      try {
        worker.send(start);
        await worker.waitFor('ready');
        const pedido = await worker.waitFor('tool.request');
        expect(pedido).toMatchObject({ call_seq: 0, name: 'fixture_echo' });
        worker.send({
          protocol: 'maia.hermes.worker.v1',
          type: 'tool.result',
          run_id: start.run_id,
          call_seq: 0,
          outcome: { kind: 'result', result: { eco: 'eco' }, is_error: false },
        });
        const result = await worker.waitFor('result');
        worker.send({
          protocol: 'maia.hermes.worker.v1',
          type: 'result_ack',
          run_id: start.run_id,
          terminal_digest: 'c'.repeat(64),
        });
        expect(await worker.exit()).toBe(0);
        expect(result.stop).toEqual({ kind: 'reply', raw_text: 'eco respondido' });
      } catch (erro) {
        // Diagnóstico obrigatório: um timeout sem estado é meia informação.
        throw new Error(`${String(erro)} | ${await diag('fluxo_do_worker')}`);
      }

      // TRÊS requests efetivos do SDK, e TRÊS tentativas admitidas — a repetição
      // do SDK é uma tentativa NOVA que passou de novo pela admissão.
      const linhas = await tentativas(run);
      expect(linhas.map((l) => l.attempt_seq)).toEqual([1, 2, 3]);
      expect(linhas.map((l) => l.state)).toEqual(['failed_after_send', 'completed', 'completed']);
      expect(linhas.map((l) => l.accounting_status)).toEqual(['unknown', 'settled', 'settled']);
      expect(linhas[0]!.last_error_code).toBe('provider_5xx');
      expect(linhas.every((l) => l.model === MODEL)).toBe(true);
      // Cada tentativa admitida corresponde a UMA chamada no provider.
      const up = stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
      expect(up).toHaveLength(3);
      expect(up.every((r) => r.body.model === MODEL)).toBe(true);
      expect(up.every((r) => r.body.stream === false)).toBe(true);

      // A credencial do RUN nunca aparece nos frames do canal (só no env do
      // spawn): o pipe autoriza tools, o grant autoriza inferência.
      const frames = JSON.stringify(worker.frames);
      expect(frames).not.toContain(grant.token);
      expect(frames).not.toContain('chave-provider-stub');
      expect(frames).toContain('fixture_echo');

      // E o token continua só como HASH no banco.
      const row = await pool.query<{ token_hash: string; total: string }>(
        `SELECT token_hash,
                (SELECT count(*) FROM engine_inference_attempts
                  WHERE tenant_id = $2 AND agent_id = $3 AND run_id = $4)::text AS total
           FROM engine_inference_grants WHERE id = $1`,
        [grant.grant_id, run.tenant, run.agent, run.run_id],
      );
      expect(row.rows[0]!.token_hash).toBe(hashInferenceToken(grant.token));
      expect(row.rows[0]!.total).toBe('3');
      const conta = await contaOrcamento(run);
      expect(Number(conta!.settled)).toBeGreaterThan(0);
      // A tentativa que falhou DEPOIS do envio continua com a reserva presa
      // como exposição até a reconciliação (§9.1 item 9): o saldo NÃO é liberado
      // por um erro cujo custo real ninguém conhece, e não vira zero.
      expect(conta!.reserved).toBe(linhas[0]!.reserved_microusd);
      expect(Number(linhas[0]!.reserved_microusd)).toBeGreaterThan(0);
    }, 240_000);
  });
});