/**
 * P07 — o SUPERVISOR contra o worker Python REAL (AIAgent do SHA pinado e
 * provider STUB). Mesmas regras do `hermes-worker-spike.spec.ts`: sem
 * `MAIA_HERMES_WORKER_PYTHON` e `MAIA_HERMES_UPSTREAM` faz `describe.skip`, e
 * nada aqui é evidência sobre provider real (D02).
 *
 * O que prova: o `ready` do worker real passa no gate do supervisor (o
 * `tool_schema_digest` do TS bate com o do Python de verdade), a tool atravessa
 * supervisor → hook → worker, o `result_ack` só sai depois do hook gravar, o
 * cancelamento pela escada encerra o turno real, e o home efêmero é apagado.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { StartFrame } from '@/integrations/hermes/protocol.js';
import {
  DEFAULT_WORKER_ARGS,
  createHermesSupervisor,
  type HermesSupervisorV1,
  type ToolOutcomeV1,
} from '@/integrations/hermes/supervisor.js';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

const REPO = resolve(process.cwd());
const SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const TOOL = 'fixture_echo';
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-supspike-'));
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const supervisors: HermesSupervisorV1[] = [];
const stubs: StubProvider[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.shutdown();
  for (const s of stubs.splice(0)) await s.close();
});

function supervisor(): HermesSupervisorV1 {
  const sup = createHermesSupervisor({
    python_executable: PYTHON as string,
    worker_args: [...DEFAULT_WORKER_ARGS],
    worker_cwd: REPO,
    python_path: [UPSTREAM as string, REPO],
    hermes_sha: SHA,
    expected_bridge_revision: 'hermes-worker-0.1.0',
    platform_env: Object.fromEntries(
      ['SystemRoot', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR']
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k] as string]),
    ),
    home_root: HOME_ROOT,
    ready_timeout_ms: 60_000,
    cancel_grace_ms: 10_000,
    exit_wait_ms: 10_000,
    post_result_exit_ms: 30_000,
    hook_timeout_ms: 5_000,
    watchdog_interval_ms: 200,
    session_retention_ms: 60_000,
  });
  supervisors.push(sup);
  return sup;
}

function startFrame(stub: StubProvider): StartFrame {
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
      tools: [
        {
          name: TOOL,
          input_schema: {
            type: 'object',
            properties: { texto: { type: 'string' } },
            required: ['texto'],
            additionalProperties: false,
          },
          result_limit_chars: 4096,
        },
      ],
      result_limit_chars: 4096,
    },
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
    inference: {
      base_url: stub.baseUrl,
      model: 'maia-stub-model',
      provider: 'openai',
      api_mode: 'chat_completions',
    },
  };
}

d('spike — supervisor + worker Python real (provider STUB)', () => {
  it('turno inteiro com tool: ready aceito, tool pelo hook, ACK depois de gravar, home apagado', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'tool_calls', calls: [{ name: TOOL, arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'ecoei para você' },
      ],
    });
    stubs.push(stub);
    const sup = supervisor();
    const onToolRequest = vi.fn(
      async (): Promise<ToolOutcomeV1> => ({ kind: 'result', result: { eco: 'eco' }, is_error: false }),
    );
    const onResult = vi.fn(async () => ({ kind: 'persisted' as const, terminal_digest: 'c'.repeat(64) }));
    const res = await sup.launch({
      start: startFrame(stub),
      inference_key: 'stub-inference-key',
      execution_deadline_ms: Date.now() + 120_000,
      max_tool_calls: 2,
      signal: new AbortController().signal,
      hooks: {
        onToolRequest,
        onResult,
        onRevoke: async () => undefined,
        revalidate: async () => true,
        leaseHorizonMs: () => Date.now() + 120_000,
      },
    });
    if (res.kind !== 'launched') throw new Error(res.reason);
    expect(await res.session.ready).toEqual({ kind: 'accepted' });
    const exit = await res.session.exited;

    expect(exit.code).toBe(0);
    expect(onToolRequest).toHaveBeenCalledTimes(1);
    const snap = res.session.snapshot();
    expect(snap.terminal?.persisted).toBe(true);
    expect(snap.terminal?.frame.stop.kind).toBe('reply');
    expect(snap.terminal?.frame.observed_tool_call_seqs).toEqual([0]);
    expect(exit.home_inventory).toContain('config.yaml');
    expect(exit.home_removed).toBe(true);
  }, 120_000);

  it('cancel durante a tool: escada revoga, pede, e o worker real encerra', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'tool_calls', calls: [{ name: TOOL, arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'nunca chega' },
      ],
    });
    stubs.push(stub);
    const sup = supervisor();
    let liberar!: () => void;
    const onRevoke = vi.fn(async () => undefined);
    const res = await sup.launch({
      start: startFrame(stub),
      inference_key: 'stub-inference-key',
      execution_deadline_ms: Date.now() + 120_000,
      max_tool_calls: 2,
      signal: new AbortController().signal,
      hooks: {
        onToolRequest: () =>
          new Promise<ToolOutcomeV1>((r) => {
            liberar = () => r({ kind: 'result', result: 'tarde', is_error: false });
          }),
        onResult: async () => ({ kind: 'persisted' as const, terminal_digest: 'c'.repeat(64) }),
        onRevoke,
        revalidate: async () => true,
        leaseHorizonMs: () => Date.now() + 120_000,
      },
    });
    if (res.kind !== 'launched') throw new Error(res.reason);
    await res.session.ready;
    await vi.waitFor(() => expect(res.session.snapshot().forwarded_calls).toBe(1), {
      timeout: 60_000,
    });
    expect(await res.session.requestCancel('operator')).toBe('requested');
    await res.session.exited;
    liberar();
    const snap = res.session.snapshot();
    expect(onRevoke).toHaveBeenCalledWith('cancel:operator');
    expect(snap.cancel?.sent).toBe(true);
    expect(snap.executor_state).toBe('cancelled');
    // A tool estava em voo quando o processo terminou: efeito não conciliado.
    expect(snap.unreconciled_calls).toBe(1);
  }, 120_000);
});
