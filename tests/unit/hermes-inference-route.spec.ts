/**
 * P06 — a rota do gateway de inferência (Fastify real, `inject`), com ledger e
 * relay dublês. Prova a ordem do §9.1: rede interna → credencial → contrato →
 * superfície → autoridade → admissão → relay → validação → liquidação.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdmitAttemptResult,
  InferenceGrantStateV1,
  SettleOutcomeV1,
} from '@/db/repositories/inference-repos.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  hashInferenceToken,
  mintInferenceToken,
} from '@/integrations/hermes/inference-credential.js';
import { INFERENCE_GATEWAY_COMPLETIONS_PATH } from '@/integrations/hermes/inference-gateway.js';
import {
  registerHermesInferenceRoute,
  type InferenceLedgerPortV1,
} from '@/integrations/hermes/inference-route.js';
import type { RelayOutcomeV1 } from '@/lib/llm/providers/chat-completions-relay.js';

const SCHEMA = {
  type: 'object',
  properties: { texto: { type: 'string' } },
  required: ['texto'],
  additionalProperties: false,
};
const MODEL = 'anthropic/claude-sonnet-4.6';
const TOKEN = mintInferenceToken();
const GRANT_ID = '11111111-1111-4111-8111-111111111111';
const TARIFF = { version: 'v1', input_nanousd_per_token: 3000, output_nanousd_per_token: 15000 };

function state(over: Partial<InferenceGrantStateV1> = {}): InferenceGrantStateV1 {
  return {
    grant_id: GRANT_ID,
    grant: {
      run_id: '22222222-2222-4222-8222-222222222222',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      control_epoch: '0',
      audience: INFERENCE_GRANT_AUDIENCE,
      model: MODEL,
      manifest_digest: 'a'.repeat(64),
      allowed_tool_names: ['fixture_echo'],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      max_inference_calls: 10,
    },
    tool_surface: { fixture_echo: canonicalDigest(SCHEMA) },
    max_output_tokens: 256,
    run_phase: 'running',
    run_manifest_digest: 'a'.repeat(64),
    run_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    calls_so_far: 0,
    control_ok: true,
    now: new Date().toISOString(),
    ...over,
  };
}

const COMPLETION = {
  id: 'gen-1',
  object: 'chat.completion',
  created: 1,
  model: MODEL,
  system_fingerprint: 'fp',
  choices: [
    { index: 0, logprobs: null, message: { role: 'assistant', content: 'olá', refusal: null }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
};

function body(over: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'oi' }],
    tools: [{ type: 'function', function: { name: 'fixture_echo', description: 'eco', parameters: SCHEMA } }],
    max_tokens: 256,
    ...over,
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function setup(
  over: {
    states?: Array<InferenceGrantStateV1 | null>;
    admit?: AdmitAttemptResult | Error;
    relay?: RelayOutcomeV1;
    resolve?: 'ok' | 'null' | 'throw';
  } = {},
) {
  const settled: SettleOutcomeV1[] = [];
  const states = over.states ?? [state()];
  let loads = 0;
  const ledger: InferenceLedgerPortV1 = {
    resolveGrantScope: vi.fn(async (h: string) => {
      if (over.resolve === 'throw') throw new Error('db');
      if (over.resolve === 'null' || h !== hashInferenceToken(TOKEN)) return null;
      return { grant_id: GRANT_ID, tenant_id: 'tenant-a', agent_id: 'agent-a' };
    }),
    loadGrantState: vi.fn(async () => states[Math.min(loads++, states.length - 1)] ?? null),
    admitAttempt: vi.fn(async (input) => {
      if (over.admit instanceof Error) throw over.admit;
      return over.admit ?? { ok: true, attempt_id: input.attempt_id, attempt_seq: 1, reserved_microusd: '10' };
    }),
    settleAttempt: vi.fn(async ({ outcome }) => {
      settled.push(outcome);
      return { ok: true as const, already: false, accounting_status: 'settled' };
    }),
  };
  const relayed: Array<Record<string, unknown>> = [];
  const relay = {
    provider: 'openrouter',
    relay: vi.fn(async (b: Readonly<Record<string, unknown>>) => {
      relayed.push({ ...b });
      return over.relay ?? { kind: 'ok' as const, raw: COMPLETION };
    }),
  };
  const app = Fastify();
  apps.push(app);
  await registerHermesInferenceRoute(app, {
    ledger,
    relay,
    tariffFor: async () => TARIFF,
    policy: { on_unpriced: 'deny' },
    runInScope: (_s, fn) => fn(),
    running_wait_ms: 300,
    poll_ms: 20,
  });
  await app.ready();
  return { app, ledger, relay, relayed, settled };
}

function post(
  app: FastifyInstance,
  payload: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  return app.inject({
    method: 'POST',
    url: INFERENCE_GATEWAY_COMPLETIONS_PATH,
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const code = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

describe('rota — rede e credencial', () => {
  it('fora da rede interna ou atrás do proxy: 404 sem tocar no ledger', async () => {
    const { app, ledger } = await setup();
    expect((await post(app, body(), { remoteAddress: '8.8.8.8' })).statusCode).toBe(404);
    expect((await post(app, body(), { headers: { 'x-forwarded-for': '1.2.3.4' } })).statusCode).toBe(404);
    expect(ledger.resolveGrantScope).not.toHaveBeenCalled();
  });

  it('sem bearer, token malformado ou desconhecido: 401 idêntico, terminal', async () => {
    const { app, ledger } = await setup();
    const semToken = await post(app, body(), { token: null });
    const malformado = await post(app, body(), { token: 'abc' });
    const desconhecido = await post(app, body(), { token: mintInferenceToken() });
    for (const r of [semToken, malformado, desconhecido]) {
      expect(r.statusCode).toBe(401);
      expect(code(r)).toBe('invalid_inference_grant');
      expect(r.headers['x-should-retry']).toBe('false');
    }
    expect(semToken.body).toBe(desconhecido.body);
    // Malformado nem consulta o banco.
    expect(ledger.resolveGrantScope).toHaveBeenCalledTimes(1);
  });

  it('ledger fora: 503 admission_unavailable, repetível', async () => {
    const { app } = await setup({ resolve: 'throw' });
    const r = await post(app, body());
    expect(r.statusCode).toBe(503);
    expect(code(r)).toBe('admission_unavailable');
    expect(r.headers['x-should-retry']).toBeUndefined();
  });
});

describe('rota — contrato, superfície e autoridade', () => {
  it.each([
    ['campo de autoridade no corpo', body({ user: 'x' }), 400, 'unsupported_parameter'],
    ['modelo diferente do aprovado', body({ model: 'outro/modelo' }), 403, 'model_not_allowed'],
    [
      'schema de tool diferente do manifest',
      body({
        tools: [{ type: 'function', function: { name: 'fixture_echo', parameters: { ...SCHEMA, required: [] } } }],
      }),
      403,
      'tool_surface_mismatch',
    ],
    ['max_tokens acima do teto do grant', body({ max_tokens: 257 }), 400, 'invalid_request'],
  ])('%s → %i %s', async (_n, payload, status, c) => {
    const { app, ledger, relay } = await setup();
    const r = await post(app, payload);
    expect(r.statusCode).toBe(status);
    expect(code(r)).toBe(c);
    expect(ledger.admitAttempt).not.toHaveBeenCalled();
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it('controle humano/epoch mudou: 403 run_revoked', async () => {
    const { app } = await setup({ states: [state({ control_ok: false })] });
    const r = await post(app, body());
    expect([r.statusCode, code(r)]).toEqual([403, 'run_revoked']);
  });

  it('run em submitting que vira running dentro da espera: segue', async () => {
    const { app } = await setup({
      states: [state({ run_phase: 'submitting' }), state({ run_phase: 'submitting' }), state()],
    });
    expect((await post(app, body())).statusCode).toBe(200);
  });

  it('run que não vira running a tempo: 409 terminal', async () => {
    const { app, relay } = await setup({ states: [state({ run_phase: 'submitting' })] });
    const r = await post(app, body());
    expect([r.statusCode, code(r)]).toEqual([409, 'run_not_active']);
    expect(r.headers['x-should-retry']).toBe('false');
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it('admissão recusada por orçamento: 429 terminal, nada sai', async () => {
    const { app, relay } = await setup({
      admit: { ok: false, code: 'budget_exhausted', audit_reason: 'admission_budget_exhausted' },
    });
    const r = await post(app, body());
    expect([r.statusCode, code(r)]).toEqual([429, 'budget_exhausted']);
    expect(r.headers['x-should-retry']).toBe('false');
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it('admissão que falha: 503, nada sai', async () => {
    const { app, relay } = await setup({ admit: new Error('db') });
    expect((await post(app, body())).statusCode).toBe(503);
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it('erro nunca carrega grant, tenant, run ou modelo', async () => {
    const { app } = await setup({ states: [state({ control_ok: false })] });
    const r = await post(app, body());
    for (const segredo of [GRANT_ID, 'tenant-a', 'agent-a', '22222222', MODEL]) {
      expect(r.body).not.toContain(segredo);
    }
  });

  it('corpo gigante e JSON quebrado: vocabulário do §9.1, sanitizado', async () => {
    const { app } = await setup();
    const grande = await post(app, JSON.stringify({ ...body(), messages: [{ role: 'user', content: 'x'.repeat(2_200_000) }] }));
    expect([grande.statusCode, code(grande)]).toEqual([413, 'payload_too_large']);
    const quebrado = await post(app, '{"model":');
    expect([quebrado.statusCode, code(quebrado)]).toEqual([400, 'invalid_request']);
  });
});

describe('rota — admissão, relay e liquidação', () => {
  it('JSON: reserva com estimativa, encaminha com o teto, liquida com o custo do uso', async () => {
    const { app, ledger, relayed, settled } = await setup();
    const r = await post(app, body({ max_tokens: undefined }));
    expect(r.statusCode).toBe(200);
    const out = r.json() as Record<string, unknown>;
    expect(out).toMatchObject({ object: 'chat.completion', usage: { total_tokens: 110 } });
    expect(out).not.toHaveProperty('system_fingerprint');

    const admit = vi.mocked(ledger.admitAttempt).mock.calls[0]![0];
    expect(admit.estimate_microusd).not.toBeNull();
    expect(admit.tariff_version).toBe('v1');
    expect(admit.tool_names_requested).toEqual(['fixture_echo']);
    expect(relayed[0]!.max_tokens).toBe(256);
    // (100*3000 + 10*15000) nanousd = 450 microusd.
    expect(settled).toEqual([
      {
        kind: 'completed',
        prompt_tokens: 100,
        completion_tokens: 10,
        cost_microusd: '450',
        source: 'gateway_estimated',
      },
    ]);
  });

  it('SSE quando o cliente pede stream (sempre, no cliente pinado)', async () => {
    const { app } = await setup();
    const r = await post(app, body({ stream: true, stream_options: { include_usage: true } }));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.body).toContain('"chat.completion.chunk"');
    expect(r.body).toContain('"total_tokens":110');
    expect(r.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('não enviado: libera; depois do envio: exposição desconhecida; os dois 503', async () => {
    const a = await setup({ relay: { kind: 'not_sent', code: 'configuration' } });
    expect((await post(a.app, body())).statusCode).toBe(503);
    expect(a.settled).toEqual([{ kind: 'not_sent', error_code: 'configuration' }]);

    const b = await setup({ relay: { kind: 'failed_after_send', code: 'timeout' } });
    expect((await post(b.app, body())).statusCode).toBe(503);
    expect(b.settled).toEqual([{ kind: 'failed_after_send', error_code: 'timeout' }]);
  });

  it('provider devolve tool fora da superfície: 403 ao filho, mas a chamada é liquidada como paga', async () => {
    const raw = {
      ...COMPLETION,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const { app, settled } = await setup({ relay: { kind: 'ok', raw } });
    const r = await post(app, body());
    expect([r.statusCode, code(r)]).toEqual([403, 'tool_surface_mismatch']);
    expect(r.body).not.toContain('terminal');
    expect(settled[0]).toMatchObject({ kind: 'completed', cost_microusd: '450' });
  });

  it('resposta sem uso: custo desconhecido, nunca zero', async () => {
    const { usage: _u, ...semUso } = COMPLETION;
    void _u;
    const { app, settled } = await setup({ relay: { kind: 'ok', raw: semUso } });
    expect((await post(app, body())).statusCode).toBe(200);
    expect(settled[0]).toMatchObject({ kind: 'completed', cost_microusd: null, source: 'unavailable' });
  });
});
