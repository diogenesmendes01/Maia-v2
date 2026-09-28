/**
 * SC25-A / D09 — CAPTURA do request EFETIVO do cliente Hermes pinado
 * (AIAgent do SHA `5d59366`) contra o gateway+relay reais e provider STUB.
 *
 * ─── O que este arquivo fecha ────────────────────────────────────────────────
 *
 * A decisão D09 ("formato real do request SDK/auxiliares") estava ABERTA: o
 * contrato do gateway admitia a enumeração LITERAL do §9.1, e a captura do
 * cliente fixado não existia como artefato. Aqui ela é medida e GUARDADA:
 *
 *   `fixtures/d09-sdk-requests.json` — requests efetivos (principal, SDK retry,
 *   follow-up), redigidos, com o schema exato derivado deles, a lista de rotas
 *   auxiliares permitida/negada vinda do PRÓPRIO worker Python, e as
 *   observações por família de modelo (`max_completion_tokens`, `developer`).
 *
 * ─── Modo verificador x modo gerador ────────────────────────────────────────
 *
 * Por padrão o teste CAPTURA de novo e exige igualdade com a fixture commitada:
 * drift de SDK (campo novo, role nova, limite com outro nome) REPROVA — é o que
 * a AC04 chama de "drift bloqueia readiness". `D09_WRITE_FIXTURE=1` é o modo
 * gerador usado para (re)gravar a fixture a partir de uma execução real; ele
 * existe para que o artefato não seja escrito à mão em nenhum momento.
 *
 * ─── Tier dos doubles (o que este teste NÃO prova) ──────────────────────────
 *
 * O provedor é STUB e o cliente do teste é o `AIAgent` real do checkout
 * pinado. O que se mede é o request que o SDK EMITE e que o gateway ADMITE; o
 * que NÃO se mede é resposta de modelo real, latência real ou custo real
 * (decisão D02). A captura é feita na fronteira do relay — o corpo que o
 * gateway admite e entrega ao relay — e não no socket do filho; essa é a
 * limitação declarada da medição.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { InferenceGrantStateV1, SettleOutcomeV1 } from '@/db/repositories/inference-repos.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  hashInferenceToken,
  mintInferenceToken,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';
import { INFERENCE_GATEWAY_BASE_PATH } from '@/integrations/hermes/inference-gateway.js';
import { checkPinnedSdkSurface } from '@/integrations/hermes/inference-sdk-surface.js';
import { registerHermesInferenceRoute } from '@/integrations/hermes/inference-route.js';
import type { StartFrame } from '@/integrations/hermes/protocol.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

const REPO = resolve(process.cwd());
const SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const MODEL = 'maia-stub-model';
const FIXTURE_PATH = resolve(REPO, 'tests/hermes-spike/fixtures/d09-sdk-requests.json');
/**
 * Modo GERADOR da fixture. Não é variável de ambiente de propósito: a receita
 * de card roda o vitest por `project_env.py`, que monta um ambiente
 * allowlistado e descarta variáveis inventadas — um `D09_WRITE_FIXTURE=1`
 * exportado na mão seria silenciosamente ignorado e o teste "geraria" nada.
 * O marcador abaixo é local, não é commitado e é removido logo após a captura.
 */
const REGEN_MARKER = resolve(REPO, 'tests/hermes-spike/fixtures/.regen-d09');
const WRITE_MODE = existsSync(REGEN_MARKER);

const TOOLS = [
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
];
type SpikeTool = (typeof TOOLS)[number];

const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-d09-'));
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

// ─── classificação de um request efetivo ────────────────────────────────────

type CallClass = 'principal' | 'retry' | 'aux';
type CapturedCall = {
  seq: number;
  class: CallClass;
  /** Por que esta chamada é desta classe — sem inferência silenciosa. */
  reason: string;
  top_level_fields: string[];
  message_roles: string[];
  message_fields: Record<string, string[]>;
  tool_object_fields: string[];
  tool_function_fields: string[];
  tool_names: string[];
  /** Nome do campo de teto de saída efetivamente emitido. */
  output_limit_field: string | null;
  stream: boolean | null;
  content_kinds: string[];
};

function fieldNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Redige o request efetivo: guarda a ESTRUTURA (nomes de campo, roles, tipos de
 * conteúdo, digests de schema) e nunca o texto da conversa, o prompt de sistema
 * nem o valor de credencial.
 */
function captureCall(seq: number, cls: CallClass, reason: string, body: Record<string, unknown>): CapturedCall {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const messageFields: Record<string, string[]> = {};
  const contentKinds = new Set<string>();
  for (const m of messages) {
    const role = typeof m.role === 'string' ? m.role : '<sem-role>';
    messageFields[role] = sortedUnique([...(messageFields[role] ?? []), ...fieldNames(m)]);
    const c = m.content;
    contentKinds.add(c === null ? 'null' : c === undefined ? 'absent' : typeof c);
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];
  const primeiroTool = tools[0] as { function?: unknown } | undefined;
  const toolNames: string[] = [];
  for (const t of tools) {
    const fn = t.function as { name?: unknown } | undefined;
    if (fn && typeof fn.name === 'string') toolNames.push(fn.name);
  }
  const limitField = ['max_tokens', 'max_completion_tokens'].find((f) => f in body) ?? null;
  return {
    seq,
    class: cls,
    reason,
    top_level_fields: fieldNames(body),
    message_roles: sortedUnique(messages.map((m) => (typeof m.role === 'string' ? m.role : '<sem-role>'))),
    message_fields: messageFields,
    tool_object_fields: fieldNames(primeiroTool),
    tool_function_fields: fieldNames(primeiroTool?.function),
    tool_names: toolNames.sort(),
    output_limit_field: limitField,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    content_kinds: sortedUnique(contentKinds),
  };
}

/**
 * JSON Schema EXATO do pedido, derivado dos requests observados.
 *
 * `additionalProperties: false` é o ponto: o schema não é uma descrição do que
 * se viu, é a afirmação de que NADA além disso é admitido. Tipo e presença vêm
 * dos valores capturados; `tools[].function.parameters` fica como objeto livre
 * porque o schema de cada tool é o do manifest normalizado — conferido por
 * digest em `tool_surface`, não por este arquivo.
 */
function deriveSchema(calls: CapturedCall[]): Record<string, unknown> {
  const presentes = calls.map((c) => new Set(c.top_level_fields));
  const todos = sortedUnique(presentes.flatMap((s) => Array.from(s)));
  const sempre = todos.filter((f) => presentes.every((s) => s.has(f)));
  const properties: Record<string, unknown> = {};
  for (const field of todos) {
    if (field === 'model' || field === 'stream') properties[field] = { type: field === 'stream' ? 'boolean' : 'string' };
    else if (field === 'max_tokens' || field === 'max_completion_tokens') {
      properties[field] = { type: 'integer', minimum: 1 };
    } else if (field === 'messages') {
      properties[field] = {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: { role: { enum: sortedUnique(calls.flatMap((c) => c.message_roles)) } },
        },
      };
    } else if (field === 'tools') {
      properties[field] = {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'function'],
          properties: {
            type: { const: 'function' },
            function: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'parameters'],
              properties: { name: { type: 'string' }, parameters: { type: 'object' } },
            },
          },
        },
      };
    } else {
      properties[field] = { type: 'object' };
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'maia.hermes.pinned-sdk.chat-completions.request.v1',
    type: 'object',
    additionalProperties: false,
    required: sempre,
    properties,
  };
}

// ─── harness (gateway real + relay real + stub) ─────────────────────────────

function grantState(model: string): InferenceGrantStateV1 {
  return {
    grant_id: randomUUID(),
    grant: {
      run_id: randomUUID(),
      tenant_id: 'tenant-d09',
      agent_id: 'agent-d09',
      control_epoch: '0',
      audience: INFERENCE_GRANT_AUDIENCE,
      model,
      manifest_digest: 'a'.repeat(64),
      allowed_tool_names: TOOLS.map((t) => t.name),
      expires_at: new Date(Date.now() + 180_000).toISOString(),
      revoked_at: null,
      max_inference_calls: 8,
    },
    tool_surface: toolSurfaceOf(TOOLS as readonly SpikeTool[], model),
    max_output_tokens: 256,
    run_phase: 'running',
    run_manifest_digest: 'a'.repeat(64),
    run_deadline_at: new Date(Date.now() + 180_000).toISOString(),
    calls_so_far: 0,
    control_ok: true,
    owner: 'ok',
    now: new Date().toISOString(),
  };
}

async function gateway(stub: StubProvider, token: string, model = MODEL) {
  const st = grantState(model);
  const admitted: string[] = [];
  const settled: SettleOutcomeV1[] = [];
  /** Corpos EFETIVOS: o que o gateway admitiu e entregou ao relay. */
  const forwarded: Record<string, unknown>[] = [];
  const app: FastifyInstance = Fastify();
  cleanup.push(() => app.close());
  const base = createChatCompletionsRelay({ provider: 'stub', apiKey: 'chave-do-provider-stub', baseURL: stub.baseUrl });
  await registerHermesInferenceRoute(app, {
    ledger: {
      resolveGrantScope: async (h) =>
        h === hashInferenceToken(token)
          ? { grant_id: st.grant_id, tenant_id: 'tenant-d09', agent_id: 'agent-d09' }
          : null,
      loadGrantState: async () => ({ ...st, calls_so_far: admitted.length, now: new Date().toISOString() }),
      admitAttempt: async (input) => {
        admitted.push(input.attempt_id);
        return { ok: true, attempt_id: input.attempt_id, attempt_seq: admitted.length, reserved_microusd: '1' };
      },
      settleAttempt: async ({ outcome }) => {
        settled.push(outcome);
        return { ok: true, already: false, accounting_status: 'settled' };
      },
    },
    relay: {
      provider: base.provider,
      relay: async (body, opts) => {
        forwarded.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        return base.relay(body, opts);
      },
    },
    tariffFor: async () => ({ version: 'tarifa-d09', input_nanousd_per_token: 1000, output_nanousd_per_token: 1000 }),
    runInScope: (_s, fn) => fn(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}${INFERENCE_GATEWAY_BASE_PATH}`, admitted, settled, forwarded };
}

type Frame = Record<string, unknown>;
const NL = String.fromCharCode(10);

function spawnWorker(token: string) {
  const home = mkdtempSync(join(HOME_ROOT, 'home-'));
  const child = spawn(PYTHON as string, ['-m', 'services.hermes_worker.main'], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONPATH: `${UPSTREAM}${process.platform === 'win32' ? ';' : ':'}${REPO}`,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HERMES_HOME: home,
      MAIA_HERMES_SHA: SHA,
      MAIA_HERMES_INFERENCE_KEY: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  }) as ChildProcessWithoutNullStreams;
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill();
  });
  const frames: Frame[] = [];
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
    send: (f: Frame) => child.stdin.write(JSON.stringify(f) + NL),
    waitFor: (type: string) =>
      new Promise<Frame>((res, rej) => {
        const found = frames.find((f) => f.type === type);
        if (found) return res(found);
        const t = setTimeout(() => rej(new Error(`timeout esperando ${type}`)), 120_000);
        waiting.push({ type, resolve: (f) => (clearTimeout(t), res(f)) });
      }),
    exit: () =>
      new Promise<number | null>((res) => {
        if (child.exitCode !== null) return res(child.exitCode);
        child.on('exit', (c) => res(c));
      }),
  };
}

function startFrame(base_url: string, model = MODEL): StartFrame {
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
      manifest_digest: 'b'.repeat(64),
      mode: 'live',
    },
    manifest: {
      schema: 'maia-hermes-runtime-manifest/v1',
      tools: TOOLS as StartFrame['manifest']['tools'],
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
    inference: { base_url, model, provider: 'openai', api_mode: 'chat_completions' },
  };
}

/** A lista auxiliar vem do PRÓPRIO worker: uma fonte, não duas. */
function auxPolicyFromWorker(): Record<string, unknown> {
  const out = execFileSync(PYTHON as string, ['-m', 'services.hermes_worker.main', '--print-aux-policy'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: `${UPSTREAM}:${REPO}`, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(out) as Record<string, unknown>;
}

d('SC25-A / D09 — captura do request efetivo do cliente pinado', () => {
  it('principal + SDK retry + follow-up, com aux demonstrado ausente do relay', async () => {
    // Roteiro: a PRIMEIRA chamada falha 5xx no provider ⇒ o gateway responde 503
    // (retryável) ⇒ o SDK pinado repete; a repetição volta com tool_call; o
    // resultado da tool dispara a chamada de follow-up, que fecha com texto.
    const stub = await startStubProvider({
      script: [
        { kind: 'error', status: 500, body: { error: { message: 'falha injetada', type: 'server_error' } } },
        { kind: 'tool_calls', calls: [{ name: 'fixture_echo', arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'eco respondido' },
      ],
    });
    cleanup.push(() => stub.close());
    const token = mintInferenceToken();
    const gw = await gateway(stub, token);
    const worker = spawnWorker(token);
    const start = startFrame(gw.base);
    worker.send(start);
    await worker.waitFor('ready');
    const pedido = await worker.waitFor('tool.request');
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
    const exit = await worker.exit();

    // Pré-condição MEDIDA do cenário: a repetição existe e passou pela admissão.
    expect(exit).toBe(0);
    expect(result.stop).toEqual({ kind: 'reply', raw_text: 'eco respondido' });
    expect(gw.forwarded).toHaveLength(3);
    expect(gw.settled.map((s) => s.kind)).toEqual(['failed_after_send', 'completed', 'completed']);
    expect(pedido).toMatchObject({ call_seq: 0, name: 'fixture_echo' });

    const calls: CapturedCall[] = [
      captureCall(1, 'principal', 'primeira chamada HTTP do run', gw.forwarded[0]!),
      captureCall(2, 'retry', 'mesma chamada lógica repetida pelo SDK após 503 do gateway', gw.forwarded[1]!),
      captureCall(3, 'principal', 'nova chamada lógica depois do tool.result', gw.forwarded[2]!),
    ];

    // A repetição é do MESMO corpo lógico: o que difere é só a posição na série.
    expect(calls[1]!.top_level_fields).toEqual(calls[0]!.top_level_fields);
    expect(calls[1]!.message_roles).toEqual(calls[0]!.message_roles);

    const aux = auxPolicyFromWorker();
    expect(aux.allowed).toEqual([]);
    const denied = aux.denied as Array<{ route: string; posture: string }>;
    expect(denied.map((r) => r.route)).toContain('compression');
    expect(denied.every((r) => r.posture === 'disabled')).toBe(true);
    // Nenhuma rota auxiliar tocou o relay nesta captura: cada corpo entregue ao
    // relay corresponde a um dos requests capturados (e `aux_calls_observed` é
    // zero no artefato).
    const conjuntos = calls.map((c) => JSON.stringify(c.top_level_fields));
    expect(gw.forwarded.every((b) => conjuntos.includes(JSON.stringify(fieldNames(b))))).toBe(true);

    const capture = {
      version: 1,
      hermes_sha: SHA,
      captured_by: 'tests/hermes-spike/hermes-inference-d09-capture.spec.ts',
      tier: {
        client: 'AIAgent REAL do checkout pinado (services/hermes_worker)',
        provider: 'stub loopback (não é modelo)',
        boundary: 'corpo admitido pelo gateway e entregue ao relay (não o socket do filho)',
      },
      redaction: [
        'valor do header Authorization (nunca registrado)',
        'texto de mensagens, prompt de sistema e argumentos de tool',
        'nome/valor de credencial de run ou de provider',
      ],
      calls,
      request_schema: deriveSchema(calls),
      aux_routes: aux,
      aux_calls_observed: 0,
    };

    if (WRITE_MODE) {
      writeFileSync(FIXTURE_PATH, JSON.stringify(capture, null, 2) + '\n', 'utf8');
    }
    // A captura VIVA passa pelo MESMO contrato que o readiness do runtime usa:
    // aqui o achado é NOMEADO (campo/rota), não só um digest diferente.
    const veredito = checkPinnedSdkSurface({
      hermes_sha: SHA,
      requests: calls.map((c) => ({
        top_level_fields: c.top_level_fields,
        message_roles: c.message_roles,
        output_limit_field: c.output_limit_field,
      })),
      aux_allowed_outside_relay: aux.allowed,
    });
    expect(veredito).toEqual({ ok: true, checked_requests: 3 });
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    const digest = (o: unknown) => canonicalDigest(JSON.parse(JSON.stringify(o)) as never);
    expect(
      digest({
        version: committed.version,
        hermes_sha: committed.hermes_sha,
        calls: committed.calls,
        request_schema: committed.request_schema,
        aux_routes: committed.aux_routes,
        aux_calls_observed: committed.aux_calls_observed,
      }),
      'drift entre a captura VIVA do cliente pinado e a fixture D09 commitada',
    ).toBe(
      digest({
        version: capture.version,
        hermes_sha: capture.hermes_sha,
        calls: capture.calls,
        request_schema: capture.request_schema,
        aux_routes: capture.aux_routes,
        aux_calls_observed: capture.aux_calls_observed,
      }),
    );
    // O esquema derivado tem de ser FECHADO (passthrough não é admissível).
    expect((capture.request_schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    // E o teto de saída realmente emitido é o que está no schema.
    expect(capture.request_schema).toHaveProperty('properties.max_tokens');
    expect(calls[0]!.output_limit_field).toBe('max_tokens');
    expect(calls[0]!.stream).toBe(true);
  }, 180_000);

  it('família gpt-5: `max_completion_tokens` e `developer` observados, não presumidos', async () => {
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'oi' }] });
    cleanup.push(() => stub.close());
    const token = mintInferenceToken();
    const model = 'openai/gpt-5';
    const gw = await gateway(stub, token, model);
    const worker = spawnWorker(token);
    const start = startFrame(gw.base, model);
    worker.send(start);
    await worker.waitFor('ready');
    const result = await worker.waitFor('result');
    worker.send({
      protocol: 'maia.hermes.worker.v1',
      type: 'result_ack',
      run_id: start.run_id,
      terminal_digest: 'c'.repeat(64),
    });
    expect(await worker.exit()).toBe(0);
    expect(result.stop).toEqual({ kind: 'reply', raw_text: 'oi' });
    expect(gw.forwarded).toHaveLength(1);
    const call = captureCall(1, 'principal', 'chamada única da família gpt-5', gw.forwarded[0]!);

    // O que o SDK pinado FAZ na família gpt-5 (capturado em `1c6a4bc4` e
    // remedido aqui): troca o nome do teto e manda o prompt como `developer`.
    const esperado = { output_limit_field: 'max_completion_tokens', system_role: 'developer' };
    const observed = {
      model: 'openai/gpt-5',
      ...esperado,
      observed_by: 'tests/hermes-spike/hermes-inference-d09-capture.spec.ts',
    };
    if (WRITE_MODE) {
      const atual = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
      atual.families = { 'gpt-5': observed };
      writeFileSync(FIXTURE_PATH, JSON.stringify(atual, null, 2) + '\n', 'utf8');
    }
    // Lido DEPOIS do modo gerador para que a asserção compare o arquivo final.
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      families?: Record<string, unknown>;
    };
    expect(committed.families?.['gpt-5']).toEqual(observed);
    // A fixture declara o mesmo fato E a observação viva do cliente o confirma.
    expect(call.output_limit_field).toBe(esperado.output_limit_field);
    expect(call.message_roles).toContain(esperado.system_role);
  }, 180_000);
});