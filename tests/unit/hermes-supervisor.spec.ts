/**
 * P07 — supervisor do worker Hermes, com processo e pipe REAIS.
 *
 * O filho é `tests/fixtures/hermes-fake-worker.mjs` rodando no próprio Node:
 * mesmo protocolo NDJSON do worker Python, sem Hermes. Cada caso prova um
 * pedaço do §6.7.2/§6.7.3: readiness conferida, bomba de tools, terminal com
 * ACK só depois de gravado, escada de cancelamento até o kill, prazo, violação
 * de protocolo e limpeza do home. O fake sai com 9 se o ambiente tiver qualquer
 * variável fora da allowlist — todo caso "feliz" prova a allowlist de novo.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultFrame, StartFrame, ToolRequestFrame } from '@/integrations/hermes/protocol.js';
import {
  PLATFORM_ENV_ALLOWLIST,
  WORKER_INFERENCE_KEY_ENV,
  buildWorkerEnv,
  createHermesSupervisor,
  verifyReadiness,
  type HermesSupervisorConfigV1,
  type HermesSupervisorV1,
  type ToolOutcomeV1,
  type WorkerSessionHooksV1,
} from '@/integrations/hermes/supervisor.js';
import { computeToolSchemaDigest } from '@/integrations/hermes/tool-schema-digest.js';

const REPO = resolve(process.cwd());
const FAKE = join(REPO, 'tests', 'fixtures', 'hermes-fake-worker.mjs');
const SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-sup-'));

afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const supervisors: HermesSupervisorV1[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.shutdown();
});

function platformEnv(): Record<string, string> {
  const env: Record<string, string> = {
    // Armadilhas: nada disto pode chegar ao filho.
    SECRET_TOKEN: 'nao-pode-vazar',
    DATABASE_URL: 'postgres://segredo',
    HERMES_HOME: 'C:\\perfil\\pessoal',
    MAIA_HERMES_INFERENCE_KEY: 'chave-do-pai',
  };
  for (const k of ['SystemRoot', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function startFrame(tools: StartFrame['manifest']['tools'] = [ECHO]): StartFrame {
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
    manifest: { schema: 'maia-hermes-runtime-manifest/v1', tools, result_limit_chars: 4096 },
    context: { system: 'Atendente de teste.', user_message: 'oi', history: [] },
    limits: {
      max_iterations: 3,
      max_output_tokens_per_call: 256,
      max_tool_calls: 2,
      max_inference_calls: 4,
      run_budget_seconds: 60,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    },
    inference: {
      base_url: 'http://127.0.0.1:9/internal/hermes-inference/v1',
      model: 'stub',
      provider: 'openai',
      api_mode: 'chat_completions',
    },
  };
}

const ECHO = {
  name: 'fixture_echo',
  input_schema: {
    type: 'object',
    properties: { texto: { type: 'string' } },
    required: ['texto'],
    additionalProperties: false,
  },
  result_limit_chars: 4096,
};

function config(scenario: string, start: StartFrame, over: Partial<HermesSupervisorConfigV1> = {}) {
  return {
    python_executable: process.execPath,
    worker_args: [FAKE, scenario, computeToolSchemaDigest(start.manifest.tools)],
    worker_cwd: REPO,
    python_path: [],
    hermes_sha: SHA,
    expected_bridge_revision: null,
    platform_env: platformEnv(),
    home_root: HOME_ROOT,
    ready_timeout_ms: 5_000,
    cancel_grace_ms: 300,
    exit_wait_ms: 5_000,
    post_result_exit_ms: 5_000,
    hook_timeout_ms: 1_000,
    watchdog_interval_ms: 50,
    session_retention_ms: 60_000,
    ...over,
  } satisfies HermesSupervisorConfigV1;
}

type Trace = string[];

function hooks(trace: Trace, over: Partial<WorkerSessionHooksV1> = {}): WorkerSessionHooksV1 {
  return {
    onToolRequest: vi.fn(async (f: ToolRequestFrame): Promise<ToolOutcomeV1> => {
      trace.push(`tool:${f.call_seq}`);
      return { kind: 'result', result: { eco: f.args }, is_error: false };
    }),
    onResult: vi.fn(async (f: ResultFrame) => {
      trace.push(`result:${f.stop.kind}`);
      return { kind: 'persisted' as const, terminal_digest: 'c'.repeat(64) };
    }),
    onRevoke: vi.fn(async (code: string) => {
      trace.push(`revoke:${code}`);
    }),
    revalidate: vi.fn(async () => true),
    leaseHorizonMs: () => Date.now() + 60_000,
    ...over,
  };
}

async function launch(
  scenario: string,
  opts: {
    start?: StartFrame;
    hooks?: Partial<WorkerSessionHooksV1>;
    config?: Partial<HermesSupervisorConfigV1>;
    max_tool_calls?: number;
    deadline_ms?: number;
    signal?: AbortSignal;
  } = {},
) {
  const start = opts.start ?? startFrame();
  const sup = createHermesSupervisor(config(scenario, start, opts.config));
  supervisors.push(sup);
  const trace: Trace = [];
  const h = hooks(trace, opts.hooks);
  const res = await sup.launch({
    start,
    inference_key: 'chave-curta-do-run',
    execution_deadline_ms: opts.deadline_ms ?? Date.now() + 60_000,
    max_tool_calls: opts.max_tool_calls ?? 2,
    signal: opts.signal ?? new AbortController().signal,
    hooks: h,
  });
  if (res.kind !== 'launched') throw new Error(`launch recusado: ${res.reason}`);
  return { sup, session: res.session, trace, hooks: h, start };
}

describe('buildWorkerEnv — allowlist do ambiente do filho', () => {
  it('só passa a allowlist de plataforma e as variáveis do supervisor', () => {
    const env = buildWorkerEnv({
      platform_env: { Path: 'C:\\bin', SECRET_TOKEN: 'x', HERMES_HOME: '/perfil', LANG: 'C' },
      python_path: ['/a', '/b'],
      home: resolve(tmpdir(), 'h'),
      hermes_sha: SHA,
      inference_key: 'k-1',
    });
    expect(env.PATH).toBe('C:\\bin');
    expect(env.LANG).toBe('C');
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.HERMES_HOME).toBe(resolve(tmpdir(), 'h'));
    expect(env[WORKER_INFERENCE_KEY_ENV]).toBe('k-1');
    expect(env.MAIA_HERMES_SHA).toBe(SHA);
    const permitidas = new Set([
      ...PLATFORM_ENV_ALLOWLIST,
      'PYTHONPATH',
      'PYTHONIOENCODING',
      'PYTHONUTF8',
      'PYTHONDONTWRITEBYTECODE',
      'PYTHONNOUSERSITE',
      'HERMES_HOME',
      'MAIA_HERMES_SHA',
      WORKER_INFERENCE_KEY_ENV,
    ]);
    for (const k of Object.keys(env)) expect(permitidas.has(k)).toBe(true);
  });

  it('recusa credencial vazia ou com quebra de linha, e home relativo', () => {
    const base = { platform_env: {}, python_path: [], home: resolve('h'), hermes_sha: SHA };
    expect(() => buildWorkerEnv({ ...base, inference_key: '' })).toThrow(TypeError);
    expect(() => buildWorkerEnv({ ...base, inference_key: 'a\nb' })).toThrow(TypeError);
    expect(() => buildWorkerEnv({ ...base, home: 'relativo', inference_key: 'k' })).toThrow(
      TypeError,
    );
  });
});

describe('verifyReadiness — gate do ready', () => {
  const start = startFrame();
  const base = {
    protocol: 'maia.hermes.worker.v1' as const,
    type: 'ready' as const,
    run_id: start.run_id,
    worker: { bridge_revision: 'r1', hermes_sha: SHA, python_version: '3.12.10' },
    effective_tool_names: ['fixture_echo'],
    tool_schema_digest: computeToolSchemaDigest(start.manifest.tools),
  };
  const expected = {
    run_id: start.run_id,
    hermes_sha: SHA,
    bridge_revision: 'r1',
    tool_names: ['fixture_echo'],
    tool_schema_digest: base.tool_schema_digest,
  };

  it('aceita o ready que bate', () => {
    expect(verifyReadiness(base, expected)).toEqual({ ok: true });
  });

  it.each([
    ['run_id_mismatch', { run_id: randomUUID() }],
    ['hermes_sha_mismatch', { worker: { ...base.worker, hermes_sha: '1'.repeat(40) } }],
    ['bridge_revision_mismatch', { worker: { ...base.worker, bridge_revision: 'r2' } }],
    ['duplicate_tool_name', { effective_tool_names: ['fixture_echo', 'fixture_echo'] }],
    ['surface_mismatch', { effective_tool_names: ['fixture_echo', 'terminal'] }],
    ['surface_mismatch', { effective_tool_names: [] }],
    ['schema_digest_mismatch', { tool_schema_digest: 'f'.repeat(64) }],
  ])('recusa %s', (reason, over) => {
    expect(verifyReadiness({ ...base, ...over }, expected)).toEqual({ ok: false, reason });
  });
});

describe('supervisor — caminho feliz com processo real', () => {
  it('start → ready → tool → result → ACK depois de gravado → exit → home apagado', async () => {
    const { session, trace, hooks: h } = await launch('happy');
    expect(await session.ready).toEqual({ kind: 'accepted' });
    const exit = await session.exited;

    // O fake sai 0 só se recebeu o result_ack; 9 se o ambiente vazou.
    expect(exit.code).toBe(0);
    expect(trace).toEqual(['tool:0', 'result:reply']);
    const snap = session.snapshot();
    expect(snap.terminal?.persisted).toBe(true);
    expect(snap.terminal?.frame.stop).toEqual({
      kind: 'reply',
      raw_text: 'tool=result:{"eco":{"texto":"oi"}}',
    });
    expect(snap.executor_state).toBe('completed');
    expect(snap.forwarded_calls).toBe(1);
    expect(snap.protocol_violation).toBeNull();
    expect(h.revalidate).toHaveBeenCalledTimes(1);
    // Terminal gravado: nenhuma revogação por saída inesperada.
    expect(h.onRevoke).not.toHaveBeenCalled();
    // Home inventariado (só nomes) e removido depois do exit.
    expect(exit.home_inventory).toEqual(['sessions/', 'sessions/turn.json', 'state.db']);
    expect(exit.home_removed).toBe(true);
  });

  it('sem tools no manifest: o turno fecha sem chamada nenhuma', async () => {
    const { session, trace } = await launch('no_tools', { start: startFrame([]) });
    expect(await session.ready).toEqual({ kind: 'accepted' });
    expect((await session.exited).code).toBe(0);
    expect(trace).toEqual(['result:reply']);
  });

  it('duas tools pedidas juntas vão ao broker UMA por vez, em ordem', async () => {
    let emVoo = 0;
    let pico = 0;
    const { session } = await launch('two_tools', {
      hooks: {
        onToolRequest: async (f) => {
          emVoo += 1;
          pico = Math.max(pico, emVoo);
          await new Promise((r) => setTimeout(r, 100));
          emVoo -= 1;
          return { kind: 'result', result: f.call_seq, is_error: false };
        },
      },
    });
    await session.exited;
    expect(pico).toBe(1);
    expect(session.snapshot().terminal?.frame.stop).toEqual({
      kind: 'reply',
      raw_text: 'a=result:0 b=result:1',
    });
  });

  it('mesmo terminal repetido: repete o ACK, não grava de novo', async () => {
    const { session, hooks: h } = await launch('result_twice_same');
    expect((await session.exited).code).toBe(0);
    expect(h.onResult).toHaveBeenCalledTimes(1);
  });
});

describe('supervisor — readiness recusada fecha o processo', () => {
  it.each([
    ['bad_digest', 'schema_digest_mismatch'],
    ['extra_tool', 'surface_mismatch'],
    ['wrong_sha', 'hermes_sha_mismatch'],
  ])('%s → refused(%s), processo morto, nenhuma tool, nenhum terminal gravado', async (sc, reason) => {
    const { session, hooks: h } = await launch(sc);
    expect(await session.ready).toEqual({ kind: 'refused', reason, exit_confirmed: true });
    await session.exited;
    expect(h.onToolRequest).not.toHaveBeenCalled();
    // O result de cancelamento que o worker manda não vira candidato.
    expect(h.onResult).not.toHaveBeenCalled();
    expect(session.snapshot().terminal).toBeNull();
    expect(h.onRevoke).toHaveBeenCalledWith('cancel:policy');
  });

  it('revalidação negativa depois do ready recusa (lease/epoch mudou)', async () => {
    const { session, hooks: h } = await launch('cooperative', {
      hooks: { revalidate: async () => false },
    });
    expect(await session.ready).toEqual({
      kind: 'refused',
      reason: 'revalidation_failed',
      exit_confirmed: true,
    });
    expect(h.onRevoke).toHaveBeenCalledWith('cancel:ownership_lost');
  });

  it('revalidação que LANÇA conta como negativa', async () => {
    const { session } = await launch('cooperative', {
      hooks: {
        revalidate: () => {
          throw new Error('db fora');
        },
      },
    });
    expect((await session.ready).kind).toBe('refused');
  });

  it('worker que sai antes do ready → exited_before_ready', async () => {
    const { session } = await launch('exit_before_ready');
    expect(await session.ready).toEqual({
      kind: 'refused',
      reason: 'exited_before_ready',
      exit_confirmed: true,
    });
    expect((await session.exited).code).toBe(2);
  });

  it('worker mudo: ready_timeout → cancel → kill', async () => {
    const { session } = await launch('no_ready', { config: { ready_timeout_ms: 300 } });
    expect(await session.ready).toEqual({
      kind: 'refused',
      reason: 'ready_timeout',
      exit_confirmed: true,
    });
    expect((await session.exited).home_removed).toBe(true);
    expect(session.snapshot().cancel).toEqual({ reason: 'policy', sent: true, ack_received: false });
  });
});

describe('supervisor — cancelamento (§6.7.3)', () => {
  it('worker cooperativo: revoga ANTES de pedir, e o terminal de cancelamento é gravado', async () => {
    const { session, trace } = await launch('cooperative');
    await session.ready;
    expect(await session.requestCancel('operator')).toBe('requested');
    expect(await session.cancellation).toEqual({ kind: 'settled' });
    await session.exited;
    expect(trace.indexOf('revoke:cancel:operator')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('revoke:cancel:operator')).toBeLessThan(trace.indexOf('result:cancelled'));
    const snap = session.snapshot();
    expect(snap.cancel).toEqual({ reason: 'operator', sent: true, ack_received: true });
    expect(snap.executor_state).toBe('cancelled');
  });

  it('worker que ignora o cancel: tolerância vence e o grupo é morto', async () => {
    const { session, hooks: h } = await launch('hang');
    await session.ready;
    await session.requestCancel('operator');
    expect(await session.cancellation).toEqual({ kind: 'settled' });
    const exit = await session.exited;
    expect(exit.code === null || exit.code !== 0).toBe(true);
    expect(session.snapshot().cancel?.ack_received).toBe(false);
    expect(session.snapshot().executor_state).toBe('cancelled');
    expect(h.onResult).not.toHaveBeenCalled();
  });

  it('hook de revogação pendurado não segura o kill', async () => {
    const { session } = await launch('hang', {
      hooks: { onRevoke: () => new Promise<void>(() => undefined) },
      config: { hook_timeout_ms: 200 },
    });
    await session.ready;
    await session.requestCancel('operator');
    expect(await session.cancellation).toEqual({ kind: 'settled' });
  });

  it('tool em voo quando o processo morre fica como efeito não conciliado', async () => {
    let liberar!: () => void;
    const { session } = await launch('tool_then_hang', {
      hooks: {
        onToolRequest: () =>
          new Promise<ToolOutcomeV1>((r) => {
            liberar = () => r({ kind: 'result', result: 'tarde', is_error: false });
          }),
      },
    });
    await session.ready;
    await vi.waitFor(() => expect(session.snapshot().forwarded_calls).toBe(1));
    await session.requestCancel('operator');
    expect(await session.cancellation).toEqual({ kind: 'reconcile_effects', unreconciled_calls: 1 });
    liberar();
  });

  it('sinal do dono abortado = ownership_lost', async () => {
    const ac = new AbortController();
    const { session } = await launch('cooperative', { signal: ac.signal });
    await session.ready;
    ac.abort();
    await session.exited;
    expect(session.snapshot().cancel?.reason).toBe('ownership_lost');
  });

  it('shutdown cancela tudo e espera o exit', async () => {
    const { sup, session } = await launch('hang');
    await session.ready;
    await sup.shutdown();
    expect(session.snapshot().cancel?.reason).toBe('shutdown');
    expect(session.snapshot().exit).not.toBeNull();
    expect(sup.activeCount()).toBe(0);
    const again = await sup.launch({
      start: startFrame(),
      inference_key: 'k',
      execution_deadline_ms: Date.now() + 1_000,
      max_tool_calls: 1,
      signal: new AbortController().signal,
      hooks: hooks([]),
    });
    expect(again).toEqual({ kind: 'refused', reason: 'shutting_down' });
  });
});

describe('supervisor — prazo (§5.8.1)', () => {
  it('prazo de execução vencido abre a escada com deadline e mata', async () => {
    const { session } = await launch('hang', { deadline_ms: Date.now() + 400 });
    await session.ready;
    await session.exited;
    expect(session.snapshot().cancel?.reason).toBe('deadline');
  });

  it('lease vencida antes do prazo → ownership_lost', async () => {
    const lease = Date.now() + 300;
    const { session } = await launch('hang', { hooks: { leaseHorizonMs: () => lease } });
    await session.ready;
    await session.exited;
    expect(session.snapshot().cancel?.reason).toBe('ownership_lost');
  });

  it('getter de lease que lança conta como lease vencida', async () => {
    const { session } = await launch('hang', {
      hooks: {
        leaseHorizonMs: () => {
          throw new Error('x');
        },
      },
    });
    await session.exited;
    expect(session.snapshot().cancel).not.toBeNull();
  });

  it('worker que não sai depois do result é encerrado', async () => {
    const { session } = await launch('result_no_exit', { config: { post_result_exit_ms: 200 } });
    await session.exited;
    expect(session.snapshot().terminal?.persisted).toBe(true);
    expect(session.snapshot().cancel?.reason).toBe('policy');
  });
});

describe('supervisor — fail-closed no pipe', () => {
  it('tool.request com run_id de outro run: violação, nada chega ao broker', async () => {
    const { session, hooks: h } = await launch('foreign_run');
    await session.ready;
    await session.exited;
    expect(h.onToolRequest).not.toHaveBeenCalled();
    expect(session.snapshot().protocol_violation).toBe('correlation_mismatch');
  });

  it('tool fora do manifest: tool_not_allowed sem chamar o broker', async () => {
    const { session, hooks: h } = await launch('unlisted_tool');
    await session.exited;
    expect(h.onToolRequest).not.toHaveBeenCalled();
    expect(session.snapshot().terminal?.frame.stop).toEqual({
      kind: 'reply',
      raw_text: 'tool=refused:tool_not_allowed',
    });
  });

  it('call_seq acima do teto real: budget_exhausted', async () => {
    const { session, hooks: h } = await launch('budget', { max_tool_calls: 2 });
    await session.exited;
    expect(h.onToolRequest).not.toHaveBeenCalled();
    expect(session.snapshot().terminal?.frame.stop).toEqual({
      kind: 'reply',
      raw_text: 'tool=refused:budget_exhausted',
    });
  });

  it('broker que lança vira effect_unknown para o modelo', async () => {
    const { session } = await launch('happy', {
      hooks: {
        onToolRequest: () => Promise.reject(new Error('handler caiu')),
      },
    });
    await session.exited;
    expect(session.snapshot().terminal?.frame.stop).toEqual({
      kind: 'reply',
      raw_text: 'tool=refused:effect_unknown',
    });
    expect(session.snapshot().unreconciled_calls).toBe(1);
  });

  it('linha sem \\n acima do teto: overflow, cancel, processo encerrado', async () => {
    const { session } = await launch('overflow');
    await session.exited;
    expect(session.snapshot().protocol_violation).toBe('frame_overflow');
  });

  it('dois terminais diferentes: conflito, o primeiro não é substituído', async () => {
    const { session, hooks: h } = await launch('result_conflict');
    await session.exited;
    const snap = session.snapshot();
    expect(snap.protocol_violation).toBe('conflicting_terminal');
    expect(snap.terminal?.conflict).toBe(true);
    expect(snap.terminal?.frame.stop).toEqual({ kind: 'reply', raw_text: 'primeiro' });
    expect(h.onResult).toHaveBeenCalledTimes(1);
  });

  it('gravação recusada: nenhum result_ack (o fake sai 7)', async () => {
    const { session } = await launch('no_tools', {
      start: startFrame([]),
      hooks: { onResult: async () => ({ kind: 'not_persisted' as const }) },
    });
    expect((await session.exited).code).toBe(7);
    expect(session.snapshot().terminal?.persisted).toBe(false);
  });

  it('crash no meio do turno: executor unknown e revogação no journal', async () => {
    const { session, hooks: h } = await launch('crash');
    expect(await session.ready).toEqual({ kind: 'accepted' });
    const exit = await session.exited;
    expect(exit.code).toBe(1);
    expect(session.snapshot().executor_state).toBe('unknown');
    expect(h.onRevoke).toHaveBeenCalledWith('worker_exited');
  });
});

describe('supervisor — launch', () => {
  it('recusa run duplicado e start fora do contrato', async () => {
    const start = startFrame();
    const sup = createHermesSupervisor(config('cooperative', start));
    supervisors.push(sup);
    const spec = {
      start,
      inference_key: 'k',
      execution_deadline_ms: Date.now() + 10_000,
      max_tool_calls: 1,
      signal: new AbortController().signal,
      hooks: hooks([]),
    };
    const [a, b] = await Promise.all([sup.launch(spec), sup.launch(spec)]);
    expect([a.kind, b.kind].sort()).toEqual(['launched', 'refused']);
    const bad = await sup.launch({ ...spec, start: { ...startFrame(), run_id: 'x' } as StartFrame });
    expect(bad).toEqual({ kind: 'refused', reason: 'invalid_start' });
  });

  it('executável inexistente: spawn_failed e home removido', async () => {
    const start = startFrame();
    const sup = createHermesSupervisor({
      ...config('happy', start),
      python_executable: join(HOME_ROOT, 'nao-existe.exe'),
    });
    supervisors.push(sup);
    const res = await sup.launch({
      start,
      inference_key: 'k',
      execution_deadline_ms: Date.now() + 10_000,
      max_tool_calls: 1,
      signal: new AbortController().signal,
      hooks: hooks([]),
    });
    expect(res).toEqual({ kind: 'refused', reason: 'spawn_failed' });
    expect(sup.get(start.run_id)).toBeUndefined();
  });

  it('config inválida falha alto', () => {
    const start = startFrame();
    expect(() => createHermesSupervisor({ ...config('x', start), home_root: 'relativo' })).toThrow();
    expect(() => createHermesSupervisor({ ...config('x', start), hermes_sha: 'abc' })).toThrow();
  });
});
