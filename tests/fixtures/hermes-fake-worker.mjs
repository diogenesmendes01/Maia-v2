// Worker FALSO de `maia.hermes.worker.v1` para os testes do supervisor.
//
// Fala o mesmo protocolo do `services/hermes_worker` pelo stdin/stdout, sem
// Python e sem Hermes, para exercitar spawn, pipe, cancelamento e kill reais.
//
// argv: <cenário> <tool_schema_digest>
//
// Antes de tudo confere o AMBIENTE: sai com 9 se faltar variável obrigatória,
// se o HERMES_HOME não for absoluto, existente e vazio, ou se aparecer qualquer
// variável fora da allowlist do supervisor.
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const [, , scenario = 'happy', digest = '0'.repeat(64)] = process.argv;
const PROTOCOL = 'maia.hermes.worker.v1';

const ALLOWED = new Set([
  'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'PYTHONPATH', 'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE',
  'HERMES_HOME', 'MAIA_HERMES_SHA', 'MAIA_HERMES_INFERENCE_KEY',
]);
// No Windows o libuv copia estas do pai quando o env do spawn não as traz
// (`required_vars` em uv/src/win/process.c). Identidade do usuário do SO, não
// segredo; fora do Windows continuam proibidas.
if (process.platform === 'win32') {
  for (const k of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE']) {
    ALLOWED.add(k);
  }
}
for (const key of Object.keys(process.env)) {
  if (!ALLOWED.has(key.toUpperCase())) process.exit(9);
}
const home = process.env.HERMES_HOME ?? '';
if (!isAbsolute(home) || !existsSync(home) || readdirSync(home).length > 0) process.exit(9);
if (!process.env.MAIA_HERMES_SHA || !process.env.MAIA_HERMES_INFERENCE_KEY) process.exit(9);

const send = (frame) => process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, ...frame })}\n`);
const nowIso = () => new Date().toISOString();

let start = null;
const waiters = [];
let buffer = '';
let acks = 0;

function onFrame(frame) {
  if (start === null) {
    start = frame;
    void main();
    return;
  }
  if (frame.type === 'result_ack') acks += 1;
  if (frame.type === 'cancel') onCancel(frame);
  const i = waiters.findIndex((w) => w.match(frame));
  if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) onFrame(JSON.parse(line));
    nl = buffer.indexOf('\n');
  }
});

const waitFor = (match, ms = 5_000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
  });

const hangForever = () => setInterval(() => {}, 1_000);

const ready = (overrides = {}) =>
  send({
    type: 'ready',
    run_id: start.run_id,
    worker: {
      bridge_revision: 'fake-worker-0.1',
      hermes_sha: process.env.MAIA_HERMES_SHA,
      python_version: 'fake',
    },
    effective_tool_names: start.manifest.tools.map((t) => t.name),
    tool_schema_digest: digest,
    ...overrides,
  });

const result = (stop, seqs = []) =>
  send({
    type: 'result',
    run_id: start.run_id,
    request_key: start.request_key,
    stop,
    iterations: 1,
    observed_tool_call_seqs: seqs,
    usage: { input_tokens: 10, output_tokens: 5, cost_microusd: null, source: 'engine_reported' },
    observed: {
      model: start.inference.model,
      provider: start.inference.provider,
      final_session_id: null,
      turn_exit_reason: null,
      failure_code: null,
    },
  });

const toolRequest = (call_seq, name, runId = start.run_id) =>
  send({
    type: 'tool.request',
    run_id: runId,
    call_seq,
    name,
    args: { texto: 'oi' },
    observed_session_id: null,
  });

const describeOutcome = (f) =>
  f ? `${f.outcome.kind}:${f.outcome.code ?? JSON.stringify(f.outcome.result ?? null)}` : 'none';

async function finishWithAck(stop, seqs, expectedAcks = 1) {
  result(stop, seqs);
  const deadline = Date.now() + 3_000;
  while (acks < expectedAcks && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  process.exit(acks >= expectedAcks ? 0 : 7);
}

let cooperative = true;
function onCancel() {
  if (!cooperative) return;
  send({ type: 'cancel_ack', run_id: start.run_id, received_at: nowIso() });
  result({ kind: 'cancelled', reason: 'operator' });
  setTimeout(() => process.exit(0), 50);
}

async function main() {
  // O motor real deixa rastros no home; o supervisor inventaria e apaga.
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'turn.json'), '{}');
  writeFileSync(join(home, 'state.db'), '');

  switch (scenario) {
    case 'happy': {
      ready();
      toolRequest(0, start.manifest.tools[0].name);
      const r = await waitFor((f) => f.type === 'tool.result' && f.call_seq === 0);
      return finishWithAck({ kind: 'reply', raw_text: `tool=${describeOutcome(r)}` }, [0]);
    }
    case 'no_tools': {
      ready();
      return finishWithAck({ kind: 'reply', raw_text: 'oi' }, []);
    }
    case 'bad_digest':
      return ready({ tool_schema_digest: 'f'.repeat(64) });
    case 'extra_tool':
      return ready({ effective_tool_names: [...start.manifest.tools.map((t) => t.name), 'terminal'] });
    case 'wrong_sha':
      return ready({ worker: { bridge_revision: 'x', hermes_sha: '1'.repeat(40), python_version: 'x' } });
    case 'exit_before_ready':
      process.exit(2);
      return;
    case 'no_ready':
      cooperative = false;
      hangForever();
      return;
    case 'hang':
      cooperative = false;
      ready();
      hangForever();
      return;
    case 'cooperative':
      ready();
      hangForever();
      return;
    case 'crash':
      ready();
      setTimeout(() => process.exit(1), 300);
      return;
    case 'foreign_run':
      ready();
      toolRequest(0, start.manifest.tools[0].name, '00000000-0000-4000-8000-000000000000');
      hangForever();
      return;
    case 'unlisted_tool': {
      ready();
      toolRequest(0, 'not_in_manifest');
      const r = await waitFor((f) => f.type === 'tool.result' && f.call_seq === 0);
      return finishWithAck({ kind: 'reply', raw_text: `tool=${describeOutcome(r)}` }, [0]);
    }
    case 'budget': {
      ready();
      toolRequest(5, start.manifest.tools[0].name);
      const r = await waitFor((f) => f.type === 'tool.result' && f.call_seq === 5);
      return finishWithAck({ kind: 'reply', raw_text: `tool=${describeOutcome(r)}` }, []);
    }
    case 'two_tools': {
      ready();
      const name = start.manifest.tools[0].name;
      toolRequest(0, name);
      toolRequest(1, name);
      const a = await waitFor((f) => f.type === 'tool.result' && f.call_seq === 0);
      const b = await waitFor((f) => f.type === 'tool.result' && f.call_seq === 1);
      return finishWithAck(
        { kind: 'reply', raw_text: `a=${describeOutcome(a)} b=${describeOutcome(b)}` },
        [0, 1],
      );
    }
    case 'tool_then_hang': {
      cooperative = false;
      ready();
      toolRequest(0, start.manifest.tools[0].name);
      hangForever();
      return;
    }
    case 'overflow':
      ready();
      process.stdout.write('x'.repeat(1_100_000));
      hangForever();
      return;
    case 'result_twice_same': {
      ready();
      const stop = { kind: 'reply', raw_text: 'igual' };
      result(stop);
      await new Promise((r) => setTimeout(r, 200));
      return finishWithAck(stop, [], 2);
    }
    case 'result_conflict':
      ready();
      result({ kind: 'reply', raw_text: 'primeiro' });
      await new Promise((r) => setTimeout(r, 200));
      result({ kind: 'reply', raw_text: 'segundo' });
      hangForever();
      return;
    case 'result_no_exit':
      cooperative = false;
      ready();
      result({ kind: 'reply', raw_text: 'fica' });
      hangForever();
      return;
    default:
      process.exit(3);
  }
}
