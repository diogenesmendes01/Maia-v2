/**
 * P00.4 (spec §6.12 gates 1/4/6, §11.3) — SPIKE SINTÉTICO com o motor REAL.
 *
 * ─── O que este arquivo prova, e o que ele explicitamente NÃO prova ─────────
 *
 * Ele sobe o worker Python de verdade, com o `AIAgent` do checkout Hermes
 * PINADO, e faz um turno inteiro atravessar o protocolo: `start` → `ready` →
 * `tool.request`/`tool.result` → `result`. O modelo do outro lado é um **STUB**
 * local (`tests/helpers/hermes-stub-provider.ts`) que devolve respostas
 * roteirizadas no formato Chat Completions.
 *
 * Isso significa: **nada aqui é evidência sobre qualidade de resposta, custo ou
 * comportamento de um provedor real** (§11.3.2 exige identificar o stub). O que
 * é evidência: o loop real do Hermes, o registry real, a superfície efetiva de
 * ferramentas, o caminho de cancelamento, a recusa de home não-efêmero e o que
 * o motor escreve no disco. O smoke com provider pago continua bloqueado por
 * decisão de orçamento (D02).
 *
 * ─── Por que ele se auto-pula ───────────────────────────────────────────────
 *
 * Exige o venv do checkout pinado. Sem `MAIA_HERMES_WORKER_PYTHON` e
 * `MAIA_HERMES_UPSTREAM`, faz `describe.skip` — e um `skip` NUNCA é reportado
 * como verde nesta entrega: o log de verificação diz quando ele rodou de fato.
 *
 * Comando local:
 *   MAIA_HERMES_WORKER_PYTHON=<upstream>/.venv/Scripts/python.exe \
 *   MAIA_HERMES_UPSTREAM=<upstream> \
 *   npm run test:hermes-spike
 *
 * ─── Por que NÃO mora em `tests/reliability` ────────────────────────────────
 *
 * Morava, e isso reprovou o job obrigatório `fault injection (#510)` na PR #766:
 * aquela lane roda `tests/reliability` inteiro com `--max-pulados 0`, e o job não
 * tem (nem deve ganhar sem decisão do dono) Python e o checkout do Hermes. Esta
 * spec não é injeção de falha de processo da #510 — é o spike de ABI do P00.4.
 * Aqui ela continua sendo coletada pela suíte comum, onde pula sem teto. O
 * contrato `tests/unit/ci/lane-de-fault-injection-no-ci.spec.ts` impede que uma
 * spec com guarda de ambiente ausente no job volte para a lane. Rodá-la de fato
 * no CI exige um job próprio com Python + Hermes pinado: decisão registrada, não
 * tomada aqui.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const SHOULD_RUN = !!PYTHON && !!UPSTREAM;
const d = SHOULD_RUN ? describe : describe.skip;

const REPO = resolve(process.cwd());
const HERMES_SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const PROTOCOL = 'maia.hermes.worker.v1';
const TOOL = 'fixture_echo';

type Frame = Record<string, unknown>;

/**
 * Ambiente ALLOWLISTED do filho (§6.6, invariante 1).
 *
 * Nada de `...process.env`: a máquina de quem roda isto tem `HERMES_HOME`
 * apontando para o perfil pessoal do Hermes Desktop e `ANTHROPIC_BASE_URL`
 * exportada. Herdar o ambiente inteiro é exatamente o modo de falha que o
 * bootstrap do worker existe para recusar.
 */
function envDoFilho(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    PATH: process.env.PATH ?? '',
    PYTHONPATH: `${UPSTREAM};${REPO}`,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    HERMES_HOME: home,
    MAIA_HERMES_SHA: HERMES_SHA,
    MAIA_HERMES_INFERENCE_KEY: 'stub-inference-key',
    ...extra,
  };
}

type Worker = {
  child: ChildProcessWithoutNullStreams;
  /** Frames emitidos pelo worker, em ordem. */
  frames: Frame[];
  stderr: string[];
  send(frame: Frame): void;
  /** Espera o próximo frame de um tipo, com prazo. */
  waitFor(type: string, timeoutMs?: number): Promise<Frame>;
  exit(): Promise<number | null>;
};

function spawnWorker(home: string, extraEnv: Record<string, string> = {}): Worker {
  const child = spawn(PYTHON as string, ['-m', 'services.hermes_worker.main'], {
    cwd: REPO,
    env: envDoFilho(home, extraEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  }) as ChildProcessWithoutNullStreams;

  const frames: Frame[] = [];
  const stderr: string[] = [];
  const aguardando: Array<{ type: string; resolve: (f: Frame) => void }> = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let quebra = buffer.indexOf('\n');
    while (quebra >= 0) {
      const linha = buffer.slice(0, quebra).trim();
      buffer = buffer.slice(quebra + 1);
      if (linha.length > 0) {
        const frame = JSON.parse(linha) as Frame;
        frames.push(frame);
        const idx = aguardando.findIndex((a) => a.type === frame.type);
        if (idx >= 0) aguardando.splice(idx, 1)[0]?.resolve(frame);
      }
      quebra = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  return {
    child,
    frames,
    stderr,
    send: (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`),
    waitFor: (type: string, timeoutMs = 60_000) =>
      new Promise<Frame>((resolveP, rejectP) => {
        const existente = frames.find((f) => f.type === type);
        if (existente) return resolveP(existente);
        const timer = setTimeout(() => {
          rejectP(
            new Error(
              `timeout esperando frame "${type}". Recebidos: ${frames
                .map((f) => String(f.type))
                .join(',')}. stderr: ${stderr.join('').slice(-800)}`,
            ),
          );
        }, timeoutMs);
        aguardando.push({
          type,
          resolve: (f) => {
            clearTimeout(timer);
            resolveP(f);
          },
        });
      }),
    exit: () =>
      new Promise<number | null>((resolveP) => {
        if (child.exitCode !== null) return resolveP(child.exitCode);
        child.on('exit', (code) => resolveP(code));
      }),
  };
}

function startFrame(stub: StubProvider, run_id: string, request_key: string): Frame {
  return {
    protocol: PROTOCOL,
    type: 'start',
    run_id,
    request_key,
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
      deadline_at: '2026-12-31T23:59:59.000Z',
    },
    inference: {
      base_url: stub.baseUrl,
      model: 'maia-stub-model',
      provider: 'openai',
      api_mode: 'chat_completions',
    },
  };
}

const homesCriados: string[] = [];
const workers: Worker[] = [];
const stubs: StubProvider[] = [];

function novoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'maia-hermes-spike-'));
  // O bootstrap exige home VAZIO; `mkdtemp` já entrega assim.
  homesCriados.push(home);
  return home;
}

afterEach(async () => {
  for (const w of workers.splice(0)) {
    if (w.child.exitCode === null) w.child.kill();
  }
  for (const s of stubs.splice(0)) await s.close();
  for (const home of homesCriados.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

d('spike sintético — worker + AIAgent real contra provider STUB', () => {
  it('T53 — a superfície efetiva é EXATAMENTE o manifest, e é ela que chega ao provider', async () => {
    // Sem `tools.tool_search.enabled: "off"` no config do home efêmero, a
    // superfície viraria `tool_search`/`tool_describe`/`tool_call` e a tool da
    // Maia sumiria — foi medido por probe, não deduzido. O gate exige igualdade
    // EXATA, não subconjunto.
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'oi!' }] });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    worker.send(startFrame(stub, run_id, randomUUID()));

    const ready = await worker.waitFor('ready');
    expect(ready.effective_tool_names).toEqual([TOOL]);
    expect((ready.worker as Record<string, string>).hermes_sha).toBe(HERMES_SHA);

    const result = await worker.waitFor('result');
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    expect(await worker.exit()).toBe(0);

    // A superfície REALMENTE enviada ao provider (§6.6, invariante 4).
    const requisicoes = stub.requests.filter((r) => r.path.endsWith('/chat/completions'));
    expect(requisicoes.length).toBeGreaterThan(0);
    for (const req of requisicoes) expect(req.toolNames).toEqual([TOOL]);
    // E a credencial curta chegou por HEADER, não por prompt.
    expect(requisicoes[0]?.headers.authorization).toBe('<redigido>');
    expect(JSON.stringify(requisicoes[0]?.body)).not.toContain('stub-inference-key');

    expect((result.stop as Record<string, unknown>).kind).toBe('reply');
  });

  it('a ferramenta atravessa o pipe com call_seq zero e o resultado volta ao modelo', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'tool_calls', calls: [{ name: TOOL, arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'ecoei para você' },
      ],
    });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    worker.send(startFrame(stub, run_id, randomUUID()));
    await worker.waitFor('ready');

    const pedido = await worker.waitFor('tool.request');
    expect(pedido.call_seq).toBe(0);
    expect(pedido.name).toBe(TOOL);
    expect(pedido.args).toEqual({ texto: 'eco' });

    worker.send({
      protocol: PROTOCOL,
      type: 'tool.result',
      run_id,
      call_seq: 0,
      outcome: { kind: 'result', result: { eco: 'eco' }, is_error: false },
    });

    const result = await worker.waitFor('result');
    expect(result.observed_tool_call_seqs).toEqual([0]);
    expect((result.stop as Record<string, unknown>).kind).toBe('reply');
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    expect(await worker.exit()).toBe(0);
  });

  it('T28 — tool fora do manifest não vira tool.request (o registry real não a conhece)', async () => {
    const stub = await startStubProvider({
      script: [
        { kind: 'tool_calls', calls: [{ name: 'terminal_exec', arguments: { cmd: 'whoami' } }] },
        { kind: 'text', content: 'não consigo fazer isso' },
      ],
    });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    worker.send(startFrame(stub, run_id, randomUUID()));
    await worker.waitFor('ready');
    const result = await worker.waitFor('result');

    expect(worker.frames.filter((f) => f.type === 'tool.request')).toHaveLength(0);
    expect(result.observed_tool_call_seqs).toEqual([]);
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    await worker.exit();
  });

  it('T54 — HERMES_HOME apontando para o perfil pessoal é RECUSADO antes de qualquer import', async () => {
    // O bootstrap recusa com código próprio (2). Nada pode ser escrito no
    // perfil pessoal — inclusive porque só o import já criaria state.db lá.
    const perfilPessoal = join(process.env.LOCALAPPDATA ?? tmpdir(), 'hermes');
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'x' }] });
    stubs.push(stub);
    const worker = spawnWorker(perfilPessoal);
    workers.push(worker);

    const code = await worker.exit();
    expect(code).toBe(2);
    expect(worker.stderr.join('')).toMatch(/perfil pessoal|bootstrap recusado/i);
    expect(worker.frames).toHaveLength(0);
  });

  it('T55 — o home efêmero acumula estado do motor, e o inventário sai no log', async () => {
    // `session_db=None` NÃO é promessa de zero persistência: só o import cria
    // `state.db`, `SOUL.md`, `memories/` e `sessions/` (§6.7.1). Saber disso é o
    // que transforma retenção em decisão, e não em surpresa.
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'oi' }] });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    worker.send(startFrame(stub, run_id, randomUUID()));
    await worker.waitFor('result');
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    await worker.exit();

    expect(existsSync(home)).toBe(true);
    const conteudo = readdirSync(home);
    expect(conteudo).toContain('state.db');
    expect(conteudo).toContain('config.yaml');
    const inventario = worker.stderr.join('');
    expect(inventario).toMatch(/\[hermes-worker\] home: /);
  });

  it('cancelamento durante o turno devolve cancel_ack e desfecho cancelado, não um reply', async () => {
    // O stub segura a resposta: isso põe o motor DENTRO do round-trip, que é
    // onde o cancelamento precisa funcionar (§6.7.3).
    const stub = await startStubProvider({ script: [] });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    worker.send(startFrame(stub, run_id, randomUUID()));
    await worker.waitFor('ready');
    await new Promise((r) => setTimeout(r, 500));

    worker.send({
      protocol: PROTOCOL,
      type: 'cancel',
      run_id,
      reason: 'operator',
      grace_deadline_at: '2026-12-31T23:59:59.000Z',
    });

    const ack = await worker.waitFor('cancel_ack');
    expect(ack.run_id).toBe(run_id);

    const result = await worker.waitFor('result');
    const stop = result.stop as Record<string, unknown>;
    expect(stop.kind).not.toBe('reply');
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    await worker.exit();
  }, 120_000);

  // Achado de revisão da PR #766: o bootstrap descartava o que vinha colado ao
  // `start`. Aqui os dois frames saem num ÚNICO write. O pipe pode entregá-los
  // num read só (o caso do achado) ou em dois (a bomba lê o cancel durante a
  // construção) — nos dois o §6.7.3 item 2 exige o mesmo: sem `ready`, sem loop.
  it('cancel escrito junto com o start: sem ready, sem inferência, desfecho cancelado', async () => {
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'não deveria sair' }] });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    const run_id = randomUUID();
    const cancel = {
      protocol: PROTOCOL,
      type: 'cancel',
      run_id,
      reason: 'operator',
      grace_deadline_at: '2026-12-31T23:59:59.000Z',
    };
    worker.child.stdin.write(
      `${JSON.stringify(startFrame(stub, run_id, randomUUID()))}\n${JSON.stringify(cancel)}\n`,
    );

    const result = await worker.waitFor('result');
    expect(result.stop).toEqual({ kind: 'cancelled', reason: 'operator' });
    expect(result.iterations).toBe(0);
    expect(result.observed_tool_call_seqs).toEqual([]);
    worker.send({ protocol: PROTOCOL, type: 'result_ack', run_id, terminal_digest: 'c'.repeat(64) });
    expect(await worker.exit()).toBe(0);

    expect(worker.frames.map((f) => f.type)).toEqual(['cancel_ack', 'result']);
    expect(stub.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(0);
  }, 120_000);

  it('segundo start escrito junto com o primeiro: encerra com erro de protocolo, sem frame nenhum', async () => {
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'não deveria sair' }] });
    stubs.push(stub);
    const home = novoHome();
    const worker = spawnWorker(home);
    workers.push(worker);

    // `exit` pode chegar antes do último `data` do stdout; "nenhum frame" só
    // vale depois do fim do stream.
    const fimDoStdout = new Promise<void>((r) => worker.child.stdout.once('end', () => r()));
    const linha = `${JSON.stringify(startFrame(stub, randomUUID(), randomUUID()))}\n`;
    worker.child.stdin.write(linha + linha);

    // EXIT_PROTOCOL = 4 em services/hermes_worker/main.py.
    expect(await worker.exit()).toBe(4);
    await fimDoStdout;
    expect(worker.frames).toEqual([]);
    expect(stub.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(0);
  }, 120_000);
});
