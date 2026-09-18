/**
 * P06 — o GATEWAY contra o cliente Hermes REAL (AIAgent do SHA pinado, no
 * worker `services/hermes_worker`), com o relay real até um provider STUB. Pula sem
 * `MAIA_HERMES_WORKER_PYTHON`/`MAIA_HERMES_UPSTREAM`, como os outros spikes.
 *
 * É o gate de compatibilidade do §9.1 (D09) medido, não presumido: o cliente
 * pinado manda `stream: true` e recebe o SSE re-emitido pela rota; manda a
 * credencial como bearer; sonda `/api/v1/models` (a rota única responde 404 e
 * o turno segue); e os `parameters` das tools batem com o digest do manifest.
 * O ledger aqui é um dublê em memória — o SQL tem o spec `*-real-db` próprio.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { InferenceGrantStateV1, SettleOutcomeV1 } from '@/db/repositories/inference-repos.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  mintInferenceToken,
  hashInferenceToken,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';
import { INFERENCE_GATEWAY_BASE_PATH } from '@/integrations/hermes/inference-gateway.js';
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
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-gwspike-'));
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function grantState(): InferenceGrantStateV1 {
  return {
    grant_id: randomUUID(),
    grant: {
      run_id: randomUUID(),
      tenant_id: 'tenant-spike',
      agent_id: 'agent-spike',
      control_epoch: '0',
      audience: INFERENCE_GRANT_AUDIENCE,
      model: MODEL,
      manifest_digest: 'a'.repeat(64),
      allowed_tool_names: TOOLS.map((t) => t.name),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      revoked_at: null,
      max_inference_calls: 4,
    },
    tool_surface: toolSurfaceOf(TOOLS),
    max_output_tokens: 256,
    run_phase: 'running',
    run_manifest_digest: 'a'.repeat(64),
    run_deadline_at: new Date(Date.now() + 120_000).toISOString(),
    calls_so_far: 0,
    control_ok: true,
    now: new Date().toISOString(),
  };
}

async function gateway(stub: StubProvider, token: string) {
  const st = grantState();
  const admitted: string[] = [];
  const settled: SettleOutcomeV1[] = [];
  const app: FastifyInstance = Fastify();
  cleanup.push(() => app.close());
  await registerHermesInferenceRoute(app, {
    ledger: {
      resolveGrantScope: async (h) =>
        h === hashInferenceToken(token)
          ? { grant_id: st.grant_id, tenant_id: 'tenant-spike', agent_id: 'agent-spike' }
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
    relay: createChatCompletionsRelay({ provider: 'stub', apiKey: 'upstream-key', baseURL: stub.baseUrl }),
    tariffFor: async () => ({ version: 'v', input_nanousd_per_token: 1000, output_nanousd_per_token: 1000 }),
    policy: { on_unpriced: 'deny' },
    runInScope: (_s, fn) => fn(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}${INFERENCE_GATEWAY_BASE_PATH}`, admitted, settled };
}

type Frame = Record<string, unknown>;

const NL = String.fromCharCode(10);

/** Sobe o worker real com env allowlisted e credencial só por env. */
function spawnWorker(token: string) {
  const home = mkdtempSync(join(HOME_ROOT, 'home-'));
  const child = spawn(PYTHON as string, ['-m', 'services.hermes_worker.main'], {
    cwd: REPO,
    env: {
      SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
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
    send: (f: Frame) => child.stdin.write(JSON.stringify(f) + NL),
    waitFor: (type: string) =>
      new Promise<Frame>((res, rej) => {
        const found = frames.find((f) => f.type === type);
        if (found) return res(found);
        const t = setTimeout(() => rej(new Error(`timeout esperando ${type}`)), 90_000);
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
      manifest_digest: 'b'.repeat(64),
      mode: 'live',
    },
    manifest: { schema: 'maia-hermes-runtime-manifest/v1', tools: TOOLS, result_limit_chars: 4096 },
    context: {
      system: 'Você é um atendente de teste. Responda curto.',
      user_message: '<user_message>diga oi</user_message>',
      history: [],
    },
    limits: {
      max_iterations: 3,
      max_output_tokens_per_call: 256,
      max_tool_calls: 2,
      max_inference_calls: 4,
      run_budget_seconds: 120,
      deadline_at: new Date(Date.now() + 120_000).toISOString(),
    },
    inference: { base_url, model: MODEL, provider: 'openai', api_mode: 'chat_completions' },
  };
}

d('spike — gateway de inferência com o cliente Hermes real', () => {
  it('turno com tool atravessa a rota: SSE, bearer, /models 404 e digest de schema', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'tool_calls', calls: [{ name: 'fixture_echo', arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'ecoei para você' },
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
    expect(pedido).toMatchObject({ call_seq: 0, name: 'fixture_echo', args: { texto: 'eco' } });
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
    expect(result.stop).toEqual({ kind: 'reply', raw_text: 'ecoei para você' });
    expect(result.observed_tool_call_seqs).toEqual([0]);

    // Duas inferências admitidas e liquidadas com custo conhecido.
    expect(gw.admitted).toHaveLength(2);
    expect(gw.settled.map((s) => s.kind)).toEqual(['completed', 'completed']);
    expect(gw.settled.every((s) => s.kind === 'completed' && s.cost_microusd !== null)).toBe(true);
    // O upstream recebeu sem streaming, com a credencial do PROVIDER, não a do run.
    const upstream = stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
    expect(upstream).toHaveLength(2);
    expect(upstream.every((r) => r.body.stream === false)).toBe(true);
    expect(JSON.stringify(upstream)).not.toContain(token);
  }, 120_000);
});
