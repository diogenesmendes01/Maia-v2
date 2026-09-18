/**
 * P07 (spec §5.8.1, §6.3, §6.4.2, §6.7.2, §6.7.3, §6.11) — o SUPERVISOR do
 * worker Hermes: o encanamento que `supervisor-policy.ts` decide.
 *
 * Um processo por tentativa, um `start` por processo, nenhuma reutilização. O
 * supervisor cria o filho sem shell, com ambiente ALLOWLISTED e `HERMES_HOME`
 * novo; entrega o `start`; confere o `ready`; bombeia `tool.request` para quem
 * o chamou; recebe o `result`; e garante que o processo termina — por conta
 * própria, por cancelamento ou por kill.
 *
 * ─── O que ele NÃO decide ───────────────────────────────────────────────────
 *
 * Não resolve tenant, pessoa, conversa nem grant: quem chama entrega o `start`
 * já montado a partir do `RunBinding` da Maia. Não executa ferramenta: repassa o
 * pedido ao hook `onToolRequest` (o broker da Maia) e devolve o desfecho. Não
 * persiste resultado: repassa ao hook `onResult` e só manda `result_ack` quando
 * o hook confirma a gravação. Nenhum campo do frame escolhe contexto — `run_id`
 * divergente é violação de protocolo, não roteamento.
 *
 * ─── Autoridade do filho ────────────────────────────────────────────────────
 *
 * O filho só tem autoridade enquanto: o `ready` foi conferido, o pipe está vivo,
 * as capacidades não foram revogadas e nenhum terminal chegou. Fora disso todo
 * `tool.request` é recusado. Perder o pipe é perder a autoridade (§6.4.2).
 *
 * ─── Terminar é obrigação, não cortesia ─────────────────────────────────────
 *
 * A escada de cancelamento é a de `decideCancellation` (§6.7.3): revogar, pedir,
 * esperar a tolerância, matar o grupo e esperar o SO confirmar o exit. O
 * watchdog de prazo (`deadlinePosture`) abre a escada e, se ela travar, mata
 * direto. Todo hook tem teto: um hook lento nunca mantém um processo vivo.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { canonicalDigest } from './canonical-json.js';
import { NdjsonLineSplitter, type NdjsonLineEvent } from './ndjson-lines.js';
import {
  HERMES_WORKER_PROTOCOL_VERSION,
  WIRE_LIMITS,
  parseWorkerFrame,
  serializeFrame,
  type MaiaToWorkerFrame,
  type ReadyFrame,
  type ResultFrame,
  type StartFrame,
  type ToolRequestFrame,
  type ToolResultFrame,
} from './protocol.js';
import {
  decideCancellation,
  deadlinePosture,
  type CancelReasonV1,
  type ExecutorObservedStateV1,
} from './supervisor-policy.js';
import { computeToolSchemaDigest } from './tool-schema-digest.js';

// ─── configuração ───────────────────────────────────────────────────────────

/**
 * Variáveis de plataforma que PODEM descer ao filho, e só elas. Nada de
 * `...process.env`: o ambiente do processo Maia tem credenciais de banco, Redis,
 * WhatsApp e provider, e o do operador pode ter `HERMES_HOME` apontando para o
 * perfil pessoal. Comparação sem caixa (o Windows entrega `Path`).
 */
export const PLATFORM_ENV_ALLOWLIST = [
  'SystemRoot',
  'WINDIR',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;

/** Credencial curta de inferência: só por env, nunca por frame (§9.1). */
export const WORKER_INFERENCE_KEY_ENV = 'MAIA_HERMES_INFERENCE_KEY';

export const DEFAULT_WORKER_ARGS = ['-m', 'services.hermes_worker.main'] as const;

const SHA1_RE = /^[0-9a-f]{40}$/;
const INFERENCE_KEY_RE = /^[\x21-\x7e]{1,4096}$/;

const ms = (min: number, max: number) => z.number().int().min(min).max(max);

export const hermesSupervisorConfigV1Schema = z
  .object({
    python_executable: z.string().min(1),
    worker_args: z.array(z.string().min(1)).min(1).max(32),
    worker_cwd: z.string().min(1).refine(isAbsolute, 'worker_cwd precisa ser absoluto'),
    python_path: z.array(z.string().min(1)).max(16),
    hermes_sha: z.string().regex(SHA1_RE, 'hermes_sha precisa ser sha1 hex minúsculo'),
    /** `null` = qualquer revisão; string = o `ready` precisa trazer exatamente esta. */
    expected_bridge_revision: z.string().min(1).max(128).nullable(),
    platform_env: z.record(z.string()),
    home_root: z.string().min(1).refine(isAbsolute, 'home_root precisa ser absoluto'),
    ready_timeout_ms: ms(1, 600_000),
    cancel_grace_ms: ms(0, 600_000),
    /** Espera pela confirmação do SO depois do kill. */
    exit_wait_ms: ms(1, 600_000),
    /** Prazo para o filho sair sozinho depois do `result`. */
    post_result_exit_ms: ms(1, 600_000),
    /** Teto de `onResult`/`onRevoke`/`revalidate`. Estourou = desfecho negativo. */
    hook_timeout_ms: ms(1, 600_000),
    watchdog_interval_ms: ms(10, 60_000),
    /** Quanto tempo a sessão encerrada continua consultável. */
    session_retention_ms: ms(0, 86_400_000),
  })
  .strict();

export type HermesSupervisorConfigV1 = z.infer<typeof hermesSupervisorConfigV1Schema>;

/**
 * Monta o ambiente do filho. Função PURA: a allowlist acima mais as variáveis
 * que o supervisor controla, escritas por último e nunca vindas de
 * `platform_env`.
 *
 * Limite conhecido: no Windows o libuv copia do pai `HOMEDRIVE`, `HOMEPATH`,
 * `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, `USERNAME` e `USERPROFILE` quando
 * o env do spawn não as traz. São identidade do usuário do SO, não segredo, e o
 * launcher de produção (D01) não é Windows.
 */
export function buildWorkerEnv(input: {
  platform_env: Readonly<Record<string, string>>;
  python_path: readonly string[];
  home: string;
  hermes_sha: string;
  inference_key: string;
}): Record<string, string> {
  if (!INFERENCE_KEY_RE.test(input.inference_key)) {
    throw new TypeError('buildWorkerEnv: credencial de inferência ausente ou com caractere proibido');
  }
  if (!SHA1_RE.test(input.hermes_sha)) {
    throw new TypeError('buildWorkerEnv: hermes_sha inválido');
  }
  if (!isAbsolute(input.home)) {
    throw new TypeError('buildWorkerEnv: HERMES_HOME precisa ser absoluto');
  }
  const env: Record<string, string> = {};
  const byUpper = new Map(PLATFORM_ENV_ALLOWLIST.map((k) => [k.toUpperCase(), k] as const));
  for (const [key, value] of Object.entries(input.platform_env)) {
    const canonical = byUpper.get(key.toUpperCase());
    if (!canonical || canonical in env) continue;
    if (value.includes('\0')) continue;
    env[canonical] = value;
  }
  env.PYTHONPATH = input.python_path.join(delimiter);
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONNOUSERSITE = '1';
  env.HERMES_HOME = input.home;
  env.MAIA_HERMES_SHA = input.hermes_sha;
  env[WORKER_INFERENCE_KEY_ENV] = input.inference_key;
  return env;
}

// ─── readiness ──────────────────────────────────────────────────────────────

export type ReadinessRefusalV1 =
  | 'run_id_mismatch'
  | 'hermes_sha_mismatch'
  | 'bridge_revision_mismatch'
  | 'duplicate_tool_name'
  | 'surface_mismatch'
  | 'schema_digest_mismatch'
  | 'revalidation_failed'
  | 'ready_timeout'
  | 'cancelled_before_ready'
  | 'exited_before_ready'
  | 'protocol_violation';

/**
 * Confere o `ready` contra o que o supervisor MANDOU (§6.7.2 item 4). Função
 * PURA. Superfície é igualdade EXATA de conjunto — subconjunto não basta, porque
 * uma tool a mais no agente é justamente a ampliação que o gate existe para
 * pegar (§6.6).
 */
export function verifyReadiness(
  ready: ReadyFrame,
  expected: {
    run_id: string;
    hermes_sha: string;
    bridge_revision: string | null;
    tool_names: readonly string[];
    tool_schema_digest: string;
  },
): { ok: true } | { ok: false; reason: ReadinessRefusalV1 } {
  if (ready.run_id !== expected.run_id) return { ok: false, reason: 'run_id_mismatch' };
  if (ready.worker.hermes_sha !== expected.hermes_sha) {
    return { ok: false, reason: 'hermes_sha_mismatch' };
  }
  if (
    expected.bridge_revision !== null &&
    ready.worker.bridge_revision !== expected.bridge_revision
  ) {
    return { ok: false, reason: 'bridge_revision_mismatch' };
  }
  const got = new Set(ready.effective_tool_names);
  if (got.size !== ready.effective_tool_names.length) {
    return { ok: false, reason: 'duplicate_tool_name' };
  }
  const want = new Set(expected.tool_names);
  if (got.size !== want.size || [...got].some((n) => !want.has(n))) {
    return { ok: false, reason: 'surface_mismatch' };
  }
  if (ready.tool_schema_digest !== expected.tool_schema_digest) {
    return { ok: false, reason: 'schema_digest_mismatch' };
  }
  return { ok: true };
}

// ─── contrato com quem lança ────────────────────────────────────────────────

export type ToolOutcomeV1 = ToolResultFrame['outcome'];

export type ResultPersistenceV1 =
  | { kind: 'persisted'; terminal_digest: string }
  | { kind: 'not_persisted' };

/** O que só o supervisor sabe sobre as chamadas deste run, entregue com o `result`. */
export interface ResultContextV1 {
  /**
   * `call_seq` que o supervisor recusou SEM repassar ao broker (sem autoridade,
   * teto, tool fora do manifest). O worker os reporta como alocados, mas eles
   * nunca chegaram ao journal — não são chamadas que o journal deva conhecer.
   */
  locally_refused_call_seqs: readonly number[];
}

/**
 * Os hooks da Maia. O supervisor nunca decide por eles, e nenhum recebe
 * contexto vindo do frame além do que o próprio protocolo carrega.
 */
export interface WorkerSessionHooksV1 {
  /** Broker da Maia. Só é chamado com readiness conferida e capacidades vivas. */
  onToolRequest(frame: ToolRequestFrame): Promise<ToolOutcomeV1>;
  /** Grava o terminal (CAS/fence do journal). `persisted` libera o `result_ack`. */
  onResult(frame: ResultFrame, context: ResultContextV1): Promise<ResultPersistenceV1>;
  /** Revogação AUTORITATIVA (journal). Falhar não impede o kill. */
  onRevoke(reason_code: string): Promise<void>;
  /** Reconsulta lease/epoch/revogação depois do `ready`. Exceção = `false`. */
  revalidate(): Promise<boolean>;
  /** Horizonte MÓVEL da lease (§5.8.1), ms epoch. Exceção ou NaN = já vencido. */
  leaseHorizonMs(): number;
}

export interface WorkerLaunchSpecV1 {
  /** O `start` já montado e conferido pela Maia. Vai UMA vez. */
  start: StartFrame;
  /** Credencial curta de inferência. Só vai para o env do filho. */
  inference_key: string;
  /** Prazo ABSOLUTO de execução, em ms epoch. */
  execution_deadline_ms: number;
  /** Teto REAL de chamadas (o wire exige >= 1; zero aqui recusa todas). */
  max_tool_calls: number;
  /** Sinal do dono: abortar = perda de posse. */
  signal: AbortSignal;
  hooks: WorkerSessionHooksV1;
}

export type ReadyOutcomeV1 =
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: ReadinessRefusalV1; exit_confirmed: boolean };

export type CancellationOutcomeV1 =
  | { kind: 'settled' }
  | { kind: 'reconcile_effects'; unreconciled_calls: number }
  | { kind: 'exit_unconfirmed' };

export interface WorkerExitReportV1 {
  code: number | null;
  signal: string | null;
  home_removed: boolean;
  /** Caminhos relativos que o filho deixou no home — só nomes, nunca conteúdo. */
  home_inventory: readonly string[];
  stderr_bytes: number;
}

export interface WorkerSessionSnapshotV1 {
  run_id: string;
  worker_instance_id: string;
  supervisor_incarnation: string;
  pid: number | null;
  readiness: 'pending' | 'verified' | 'refused';
  readiness_refusal: ReadinessRefusalV1 | null;
  executor_state: ExecutorObservedStateV1;
  capabilities_revoked: boolean;
  cancel: { reason: CancelReasonV1; sent: boolean; ack_received: boolean } | null;
  terminal: {
    frame: ResultFrame;
    persisted: boolean;
    terminal_digest: string | null;
    conflict: boolean;
  } | null;
  protocol_violation: string | null;
  forwarded_calls: number;
  unreconciled_calls: number;
  /** Recusados pelo supervisor sem chegar ao broker (e nunca repassados). */
  locally_refused_call_seqs: number[];
  /** Preenchido só depois que o SO confirmou o fim do processo. */
  exit: WorkerExitReportV1 | null;
}

export interface WorkerSessionV1 {
  readonly run_id: string;
  readonly worker_instance_id: string;
  /** Resolve quando o `ready` é aceito, ou recusado com o processo já tratado. */
  readonly ready: Promise<ReadyOutcomeV1>;
  /** Resolve quando o SO confirmou o fim e o home foi tratado. */
  readonly exited: Promise<WorkerExitReportV1>;
  /** Resolve quando o supervisor deixa de reter a sessão. */
  readonly released: Promise<void>;
  snapshot(): WorkerSessionSnapshotV1;
  /**
   * Abre a escada de cancelamento (idempotente). Resolve quando o `cancel` saiu;
   * a escada segue até o exit, em `cancellation`.
   */
  requestCancel(reason: CancelReasonV1): Promise<'requested' | 'already_exited'>;
  readonly cancellation: Promise<CancellationOutcomeV1> | null;
}

export type LaunchRefusalV1 =
  | 'duplicate_run'
  | 'shutting_down'
  | 'invalid_start'
  | 'deadline_exceeded'
  | 'ownership_lost'
  | 'home_unavailable'
  | 'spawn_failed';

export type LaunchResultV1 =
  | { kind: 'launched'; session: WorkerSessionV1 }
  | { kind: 'refused'; reason: LaunchRefusalV1 };

export interface HermesSupervisorV1 {
  readonly incarnation: string;
  readonly config: Readonly<HermesSupervisorConfigV1>;
  launch(spec: WorkerLaunchSpecV1): Promise<LaunchResultV1>;
  get(run_id: string): WorkerSessionV1 | undefined;
  /** Recusa novos launches, cancela tudo com `shutdown` e espera cada exit. */
  shutdown(): Promise<void>;
  /** Processos cujo fim ainda não foi confirmado. */
  activeCount(): number;
}

// ─── utilidades ─────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(msValue: number): Promise<void> {
  return new Promise<void>((r) => {
    const t = setTimeout(r, Math.max(0, msValue));
    t.unref?.();
  });
}

/**
 * Chama o hook com teto. Exceção síncrona, rejeição e estouro viram `fallback`
 * — que é sempre o desfecho NEGATIVO para quem chama.
 */
async function callHook<T>(fn: () => Promise<T>, msValue: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((r) => {
    timer = setTimeout(() => r(fallback), msValue);
    timer.unref?.();
  });
  try {
    const call = Promise.resolve()
      .then(fn)
      .catch(() => fallback);
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MAX_HOME_INVENTORY = 1_000;

async function inventoryHome(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_HOME_INVENTORY) return;
      const full = join(dir, entry.name);
      const rel = relative(home, full).split(sep).join('/');
      if (entry.isDirectory()) {
        found.push(`${rel}/`);
        await walk(full);
      } else {
        found.push(rel);
      }
    }
  };
  await walk(home);
  return found;
}

/**
 * Mata o GRUPO no POSIX (o filho nasce `detached`, líder do próprio grupo) e o
 * processo no Windows. Só o filho que este supervisor criou, pela referência do
 * `ChildProcess` — nunca PID solto.
 */
function killWorker(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // grupo já não existe; cai no kill do processo
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // já morto
  }
}

/**
 * Horizonte da lease pelo hook. Só +Infinity significa "sem lease"; NaN,
 * -Infinity, não-número e exceção são getter quebrado ou horizonte perdido e
 * valem como lease vencida (`t`).
 */
function leaseHorizonOf(hooks: WorkerSessionHooksV1, t: number): number {
  let lease: number;
  try {
    lease = hooks.leaseHorizonMs();
  } catch {
    return t;
  }
  if (typeof lease !== 'number' || Number.isNaN(lease) || lease === Number.NEGATIVE_INFINITY) {
    return t;
  }
  return lease;
}

/** Quanto esperar o `close` dos pipes depois do `exit` (neto segurando stdout). */
const CLOSE_AFTER_EXIT_MS = 2_000;

// ─── o supervisor ───────────────────────────────────────────────────────────

export function createHermesSupervisor(
  rawConfig: HermesSupervisorConfigV1,
  opts: { now?: () => number } = {},
): HermesSupervisorV1 {
  const config = Object.freeze(hermesSupervisorConfigV1Schema.parse(rawConfig));
  const now = opts.now ?? Date.now;
  const incarnation = randomUUID();
  /** `null` = reservado por um launch em andamento. */
  const sessions = new Map<string, WorkerSessionV1 | null>();
  let shuttingDown = false;

  /** Launches ainda em andamento: o shutdown espera por eles também. */
  const pending = new Set<Promise<LaunchResultV1>>();

  function launch(spec: WorkerLaunchSpecV1): Promise<LaunchResultV1> {
    const p = doLaunch(spec);
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  }

  async function doLaunch(spec: WorkerLaunchSpecV1): Promise<LaunchResultV1> {
    if (shuttingDown) return { kind: 'refused', reason: 'shutting_down' };
    const run_id = spec.start.run_id;
    if (sessions.has(run_id)) return { kind: 'refused', reason: 'duplicate_run' };

    let startLine: string;
    let expectedSchemaDigest: string;
    try {
      startLine = serializeFrame(spec.start);
      expectedSchemaDigest = computeToolSchemaDigest(spec.start.manifest.tools);
    } catch {
      return { kind: 'refused', reason: 'invalid_start' };
    }
    if (
      !Number.isInteger(spec.max_tool_calls) ||
      spec.max_tool_calls < 0 ||
      !Number.isFinite(spec.execution_deadline_ms)
    ) {
      return { kind: 'refused', reason: 'invalid_start' };
    }
    if (spec.execution_deadline_ms <= now()) return { kind: 'refused', reason: 'deadline_exceeded' };
    // §6.11: "Só uma lease válida pode lançar." Posse perdida não ganha processo.
    const ownershipLost = (): boolean =>
      spec.signal.aborted || leaseHorizonOf(spec.hooks, now()) <= now();
    if (ownershipLost()) return { kind: 'refused', reason: 'ownership_lost' };

    // Reserva ANTES do primeiro await: dois launches do mesmo run no mesmo tick
    // não criam dois processos.
    sessions.set(run_id, null);
    const refuse = async (reason: LaunchRefusalV1, home?: string): Promise<LaunchResultV1> => {
      sessions.delete(run_id);
      if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
      return { kind: 'refused', reason };
    };

    let home: string;
    try {
      home = await mkdtemp(join(config.home_root, 'maia-hermes-'));
    } catch {
      return refuse('home_unavailable');
    }
    // Daqui até o registro da sessão não há await: um shutdown que começou
    // durante o mkdtemp é visto aqui; um que começa depois vê a sessão.
    if (shuttingDown) return refuse('shutting_down', home);
    if (ownershipLost()) return refuse('ownership_lost', home);

    let env: Record<string, string>;
    try {
      env = buildWorkerEnv({
        platform_env: config.platform_env,
        python_path: config.python_path,
        home,
        hermes_sha: config.hermes_sha,
        inference_key: spec.inference_key,
      });
    } catch {
      return refuse('invalid_start', home);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.python_executable, [...config.worker_args], {
        cwd: config.worker_cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch {
      return refuse('spawn_failed', home);
    }

    if (typeof child.pid !== 'number') {
      // ENOENT/EACCES: o erro chega no próximo tick. O processo não existiu.
      await new Promise<void>((r) => {
        child.once('error', () => r());
        const t = setTimeout(r, 1_000);
        t.unref?.();
      });
      return refuse('spawn_failed', home);
    }

    const session = createSession({
      spec,
      child,
      home,
      startLine,
      expectedSchemaDigest,
      config,
      now,
      incarnation,
      onRelease: () => {
        if (sessions.get(run_id) === session) sessions.delete(run_id);
      },
    });
    sessions.set(run_id, session);
    return { kind: 'launched', session };
  }

  const live = (): WorkerSessionV1[] =>
    [...sessions.values()].filter((s): s is WorkerSessionV1 => s !== null);

  return {
    incarnation,
    config,
    launch,
    get: (run_id) => sessions.get(run_id) ?? undefined,
    async shutdown() {
      shuttingDown = true;
      // Um launch em voo termina recusado ou com sessão; a sessão também cai.
      const inflight = await Promise.all([...pending]);
      const all = new Set<WorkerSessionV1>(live());
      for (const r of inflight) if (r.kind === 'launched') all.add(r.session);
      await Promise.all(
        [...all].map(async (s) => {
          await s.requestCancel('shutdown');
          await s.exited;
        }),
      );
    },
    activeCount: () => live().filter((s) => s.snapshot().exit === null).length,
  };
}

// ─── uma sessão = um processo = uma tentativa ───────────────────────────────

function createSession(args: {
  spec: WorkerLaunchSpecV1;
  child: ChildProcessWithoutNullStreams;
  home: string;
  startLine: string;
  expectedSchemaDigest: string;
  config: Readonly<HermesSupervisorConfigV1>;
  now: () => number;
  incarnation: string;
  onRelease: () => void;
}): WorkerSessionV1 {
  const { spec, child, home, config, now, expectedSchemaDigest } = args;
  const run_id = spec.start.run_id;
  const worker_instance_id = randomUUID();
  const hooks = spec.hooks;
  const toolNames = new Set(spec.start.manifest.tools.map((t) => t.name));

  const readyD = deferred<ReadyOutcomeV1>();
  const exitedD = deferred<WorkerExitReportV1>();
  const releasedD = deferred<void>();
  /** O SO confirmou o fim do processo (`exit`/`close`). É o que a escada espera. */
  const osExitD = deferred<void>();

  let readiness: 'pending' | 'verified' | 'refused' = 'pending';
  let readinessRefusal: ReadinessRefusalV1 | null = null;
  let readyFrameSeen = false;
  let executorState: ExecutorObservedStateV1 = 'admitted';
  let capabilitiesRevoked = false;
  let journalRevoked = false;
  let journalRevoking: Promise<void> | null = null;
  let protocolViolation: string | null = null;
  let cancel: { reason: CancelReasonV1; sent: boolean; ack_received: boolean } | null = null;
  let cancelSentD: Deferred<void> | null = null;
  let cancellation: Promise<CancellationOutcomeV1> | null = null;
  let graceExceeded = false;
  let terminal: WorkerSessionSnapshotV1['terminal'] = null;
  let terminalFrameDigest: string | null = null;
  let forwardedCalls = 0;
  /**
   * Chamadas cujo efeito ficou incerto: broker que falhou, `in_progress`
   * (efeito em voo) ou em voo quando o processo acabou. Só um `result` do
   * broker para a mesma chamada tira a marca.
   */
  const unreconciledSeqs = new Set<number>();
  /** Chegaram ao broker (e portanto ao journal). */
  const forwardedSeqs = new Set<number>();
  /** Recusados aqui, sem broker. Ver `ResultContextV1`. */
  const locallyRefusedSeqs = new Set<number>();
  const refuseLocally = (seq: number, code: 'run_not_authorized' | 'budget_exhausted' | 'tool_not_allowed'): void => {
    locallyRefusedSeqs.add(seq);
    replyTool(seq, { kind: 'refused', code });
  };
  const refusedOnlyLocally = (): number[] =>
    [...locallyRefusedSeqs].filter((seq) => !forwardedSeqs.has(seq)).sort((a, b) => a - b);
  let exitReport: WorkerExitReportV1 | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  /** O SO disse que o processo saiu. Síncrono, no evento. */
  let osExited = false;
  /** Pipes drenados e frames finais processados. */
  let processGone = false;
  let pipeBroken = false;
  let stderrBytes = 0;

  const queue: ToolRequestFrame[] = [];
  const queuedSeqs = new Set<number>();
  let inflightSeq: number | null = null;
  let pumping = false;

  const timers: NodeJS.Timeout[] = [];
  const arm = (fn: () => void, delay: number): void => {
    const t = setTimeout(fn, Math.max(0, delay));
    t.unref?.();
    timers.push(t);
  };

  // ── escrita: uma linha inteira por chamada; o stream preserva a ordem ──
  child.stdin.on('error', () => {
    pipeBroken = true;
  });

  function send(frame: MaiaToWorkerFrame): boolean {
    if (pipeBroken || osExited || child.stdin.destroyed || !child.stdin.writable) return false;
    let line: string;
    try {
      line = serializeFrame(frame);
    } catch {
      return false;
    }
    try {
      child.stdin.write(line);
      return true;
    } catch {
      pipeBroken = true;
      return false;
    }
  }

  function replyTool(call_seq: number, outcome: ToolOutcomeV1): void {
    const base = {
      protocol: HERMES_WORKER_PROTOCOL_VERSION,
      type: 'tool.result' as const,
      run_id,
      call_seq,
    };
    if (!send({ ...base, outcome }) && !osExited && !pipeBroken) {
      // Resultado fora do contrato (grande demais, por exemplo): recusa curta.
      send({ ...base, outcome: { kind: 'refused', code: 'protocol_error' } });
    }
  }

  // ── tempo: prazo absoluto e horizonte MÓVEL da lease (§5.8.1) ──
  const leaseHorizon = (t: number): number => leaseHorizonOf(hooks, t);

  /** `null` = dentro do prazo; senão, o motivo do cancelamento devido. */
  function timeExpired(): CancelReasonV1 | null {
    const t = now();
    const lease = leaseHorizon(t);
    if (t >= lease && lease <= spec.execution_deadline_ms) return 'ownership_lost';
    if (t >= spec.execution_deadline_ms) return 'deadline';
    if (t >= lease) return 'ownership_lost';
    return null;
  }

  function childHasAuthority(): boolean {
    if (
      readiness !== 'verified' ||
      capabilitiesRevoked ||
      terminal !== null ||
      osExited ||
      pipeBroken ||
      protocolViolation !== null
    ) {
      return false;
    }
    // Prazo e lease valem por chamada, não só no tick do watchdog.
    const expired = timeExpired();
    if (expired !== null) {
      void requestCancel(expired);
      return false;
    }
    return true;
  }

  // ── revogação: local síncrona, autoritativa pelo hook (com teto) ──
  function revokeInJournal(reason_code: string): Promise<void> {
    capabilitiesRevoked = true;
    if (journalRevoked) return journalRevoking ?? Promise.resolve();
    journalRevoked = true;
    journalRevoking = callHook(() => hooks.onRevoke(reason_code), config.hook_timeout_ms, undefined);
    return journalRevoking;
  }

  // ── escada de cancelamento (§6.7.3), dirigida por decideCancellation ──
  function requestCancel(reason: CancelReasonV1): Promise<'requested' | 'already_exited'> {
    if (processGone) return Promise.resolve('already_exited');
    capabilitiesRevoked = true;
    if (cancel === null) {
      cancel = { reason, sent: false, ack_received: false };
      cancelSentD = deferred<void>();
      cancellation = runLadder(reason);
    }
    return cancelSentD!.promise.then(() => 'requested' as const);
  }

  async function runLadder(reason: CancelReasonV1): Promise<CancellationOutcomeV1> {
    let graceDeadline = Number.POSITIVE_INFINITY;
    try {
      // Cada passo muda uma entrada da decisão; 16 é folga, não orçamento.
      for (let step = 0; step < 16; step++) {
        const d = decideCancellation({
          reason,
          capabilities_revoked: capabilitiesRevoked && journalRevoked,
          cancel_sent: cancel!.sent,
          cancel_ack_received: cancel!.ack_received,
          grace_exceeded: graceExceeded,
          process_exit_confirmed: osExited,
          unreconciled_effect_calls: unreconciledSeqs.size,
        });
        switch (d) {
          case 'revoke_capabilities':
            await revokeInJournal(`cancel:${reason}`);
            break;
          case 'send_cancel':
            graceDeadline = now() + config.cancel_grace_ms;
            send({
              protocol: HERMES_WORKER_PROTOCOL_VERSION,
              type: 'cancel',
              run_id,
              reason,
              grace_deadline_at: new Date(graceDeadline).toISOString(),
            });
            cancel!.sent = true;
            cancelSentD!.resolve();
            break;
          case 'await_grace':
            await Promise.race([osExitD.promise, sleep(graceDeadline - now())]);
            if (!osExited && now() >= graceDeadline) graceExceeded = true;
            break;
          case 'kill_process_group':
            killWorker(child);
            await Promise.race([osExitD.promise, sleep(config.exit_wait_ms)]);
            if (!osExited) return { kind: 'exit_unconfirmed' };
            break;
          case 'reconcile_effects':
            return { kind: 'reconcile_effects', unreconciled_calls: unreconciledSeqs.size };
          case 'settle_cancelled':
            return { kind: 'settled' };
          default: {
            const _never: never = d;
            void _never;
            return { kind: 'exit_unconfirmed' };
          }
        }
      }
      return { kind: 'exit_unconfirmed' };
    } finally {
      cancelSentD?.resolve();
    }
  }

  // ── readiness ──
  function refuseReadiness(reason: ReadinessRefusalV1, cancelReason: CancelReasonV1): void {
    if (readiness !== 'pending') return;
    readiness = 'refused';
    readinessRefusal = reason;
    capabilitiesRevoked = true;
    void requestCancel(cancelReason);
    // O `ready` recusado só resolve depois que o processo foi tratado: é o que
    // permite a quem chama distinguir "nunca aceito e morto" de "não sei".
    const ladder: Promise<unknown> = cancellation ?? Promise.resolve();
    void ladder.then(() => readyD.resolve({ kind: 'refused', reason, exit_confirmed: osExited }));
  }

  function violation(code: string): void {
    if (protocolViolation === null) protocolViolation = code;
    capabilitiesRevoked = true;
    if (readiness === 'pending') refuseReadiness('protocol_violation', 'policy');
    else void requestCancel('policy');
  }

  async function onReady(frame: ReadyFrame): Promise<void> {
    if (readyFrameSeen) {
      violation('duplicate_ready');
      return;
    }
    readyFrameSeen = true;
    // O único `ready` pode cruzar com uma recusa local (prazo do ready, dono
    // abortou): chega atrasado, não é violação, e não muda nada.
    if (readiness !== 'pending') return;
    const check = verifyReadiness(frame, {
      run_id,
      hermes_sha: config.hermes_sha,
      bridge_revision: config.expected_bridge_revision,
      tool_names: [...toolNames],
      tool_schema_digest: expectedSchemaDigest,
    });
    if (!check.ok) {
      refuseReadiness(check.reason, 'policy');
      return;
    }
    const ok = await callHook(() => hooks.revalidate(), config.hook_timeout_ms, false);
    // Algo decidiu enquanto revalidava: prazo, cancelamento, violação ou exit.
    if (readiness !== 'pending' || osExited) return;
    if (ok !== true) {
      refuseReadiness('revalidation_failed', 'ownership_lost');
      return;
    }
    const expired = timeExpired();
    if (expired !== null) {
      refuseReadiness('revalidation_failed', expired);
      return;
    }
    if (cancel !== null) {
      refuseReadiness('cancelled_before_ready', cancel.reason);
      return;
    }
    readiness = 'verified';
    executorState = 'running';
    readyD.resolve({ kind: 'accepted' });
    void pump();
  }

  // ── ferramentas: FIFO, uma por vez (§5.7.4 item 4) ──
  function onToolRequest(frame: ToolRequestFrame): void {
    const seq = frame.call_seq;
    // Antes do `ready` conferido não há autoridade: nem fila.
    if (readiness !== 'verified' || capabilitiesRevoked || terminal !== null) {
      refuseLocally(seq, 'run_not_authorized');
      return;
    }
    if (seq >= spec.max_tool_calls) {
      refuseLocally(seq, 'budget_exhausted');
      return;
    }
    if (!toolNames.has(frame.name)) {
      refuseLocally(seq, 'tool_not_allowed');
      return;
    }
    // Reentrega do MESMO call_seq enquanto ele está na fila ou em voo: a
    // resposta pendente atende o future do worker; despachar de novo seria uma
    // segunda operação de negócio.
    if (inflightSeq === seq || queuedSeqs.has(seq)) return;
    queue.push(frame);
    queuedSeqs.add(seq);
    void pump();
  }

  function isOutcome(value: unknown): value is ToolOutcomeV1 {
    const kind = (value as { kind?: unknown } | null)?.kind;
    return kind === 'result' || kind === 'in_progress' || kind === 'refused';
  }

  async function pump(): Promise<void> {
    if (pumping || readiness !== 'verified') return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const frame = queue.shift()!;
        queuedSeqs.delete(frame.call_seq);
        if (!childHasAuthority()) {
          refuseLocally(frame.call_seq, 'run_not_authorized');
          continue;
        }
        inflightSeq = frame.call_seq;
        forwardedSeqs.add(frame.call_seq);
        forwardedCalls += 1;
        let outcome: ToolOutcomeV1;
        try {
          const got: unknown = await hooks.onToolRequest(frame);
          // Broker que responde fora do contrato: o efeito é incerto.
          outcome = isOutcome(got) ? got : { kind: 'refused', code: 'effect_unknown' };
        } catch {
          // O broker falhou depois de receber a chamada: o efeito é incerto.
          outcome = { kind: 'refused', code: 'effect_unknown' };
        }
        inflightSeq = null;
        if (outcome.kind === 'result') unreconciledSeqs.delete(frame.call_seq);
        else if (outcome.kind === 'in_progress' || outcome.code === 'effect_unknown') {
          unreconciledSeqs.add(frame.call_seq);
        }
        // Resposta tardia não alimenta um filho sem autoridade (§6.7.3 item 6).
        if (!childHasAuthority()) {
          replyTool(frame.call_seq, { kind: 'refused', code: 'run_not_authorized' });
          continue;
        }
        replyTool(frame.call_seq, outcome);
      }
    } finally {
      pumping = false;
    }
  }

  // ── terminal ──
  async function onResult(frame: ResultFrame): Promise<void> {
    // Canal que violou o protocolo não é mais fonte de candidato (o worker
    // aplica a mesma regra a si mesmo). O run segue para reconciliação.
    if (protocolViolation !== null) return;
    if (frame.request_key !== spec.start.request_key) {
      violation('request_key_mismatch');
      return;
    }
    const digest = canonicalDigest(frame);
    if (terminal !== null) {
      if (digest !== terminalFrameDigest) {
        terminal.conflict = true;
        violation('conflicting_terminal');
        return;
      }
      // Mesmo terminal de novo: repete o ACK se já gravou; nunca regrava.
      if (terminal.persisted && terminal.terminal_digest) {
        send({
          protocol: HERMES_WORKER_PROTOCOL_VERSION,
          type: 'result_ack',
          run_id,
          terminal_digest: terminal.terminal_digest,
        });
      }
      return;
    }
    if (readiness !== 'verified') {
      // `result` sem `ready` só é legítimo como resposta a um cancelamento
      // anterior ao loop (README do worker). Não vira candidato: o run nunca
      // foi aceito, e sem ACK o worker sai pela tolerância do cancel.
      if (cancel === null) violation('result_before_ready');
      return;
    }
    const current = {
      frame,
      persisted: false,
      terminal_digest: null as string | null,
      conflict: false,
    };
    terminal = current;
    terminalFrameDigest = digest;
    executorState =
      frame.stop.kind === 'failed'
        ? 'failed'
        : frame.stop.kind === 'cancelled'
          ? 'cancelled'
          : 'completed';
    // Terminal recebido: o filho não pede mais nada.
    capabilitiesRevoked = true;
    // Revogação em curso termina ANTES de o terminal ser gravado.
    if (journalRevoking) await journalRevoking;

    const persisted = await callHook<ResultPersistenceV1>(
      () => hooks.onResult(frame, { locally_refused_call_seqs: refusedOnlyLocally() }),
      config.hook_timeout_ms,
      { kind: 'not_persisted' },
    );
    if (persisted.kind === 'persisted' && !current.conflict && protocolViolation === null) {
      current.persisted = true;
      current.terminal_digest = persisted.terminal_digest;
      // `result_ready` no journal já fecha os callbacks do run: um kill por
      // exit atrasado não precisa de outra revogação.
      journalRevoked = true;
      send({
        protocol: HERMES_WORKER_PROTOCOL_VERSION,
        type: 'result_ack',
        run_id,
        terminal_digest: persisted.terminal_digest,
      });
    }
    // Falha de close/exit é observável (§6.7.2 item 8): o prazo conta a partir
    // do ACK (ou da recusa em gravar), não do tempo do nosso próprio banco.
    arm(() => {
      if (!processGone) void requestCancel('policy');
    }, config.post_result_exit_ms);
  }

  // ── leitura do pipe, em ordem ──
  const splitter = new NdjsonLineSplitter(WIRE_LIMITS.max_frame_bytes);
  let chain: Promise<void> = Promise.resolve();

  async function handleLine(text: string): Promise<void> {
    const parsed = parseWorkerFrame(text);
    if (parsed.kind === 'invalid') {
      violation(`invalid_frame:${parsed.code}`);
      return;
    }
    const frame = parsed.frame;
    if (frame.run_id !== run_id) {
      violation('correlation_mismatch');
      return;
    }
    switch (frame.type) {
      case 'ready':
        return onReady(frame);
      case 'tool.request':
        onToolRequest(frame);
        return;
      case 'progress':
        return;
      case 'cancel_ack':
        // Observável e sem poder de encerrar nada (§6.4.2).
        if (cancel) cancel.ack_received = true;
        return;
      case 'result':
        return onResult(frame);
      default: {
        const _never: never = frame;
        void _never;
        violation('unknown_frame');
      }
    }
  }

  function feed(events: NdjsonLineEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'overflow') {
        violation('frame_overflow');
        continue;
      }
      if (ev.kind === 'invalid_utf8') {
        violation('invalid_utf8');
        continue;
      }
      chain = chain.then(() => handleLine(ev.text)).catch(() => violation('handler_error'));
    }
  }

  child.stdout.on('data', (chunk: Buffer) => feed(splitter.feed(chunk)));
  child.stderr.on('data', (chunk: Buffer) => {
    // Só conta. stderr pode trazer texto do motor: não é canal de protocolo e
    // não é retido (INV-12).
    stderrBytes += chunk.length;
  });

  // ── fim do processo ──
  function markOsExit(): void {
    if (osExited) return;
    osExited = true;
    capabilitiesRevoked = true;
    // Chamada em voo quando o processo acabou: efeito incerto.
    if (inflightSeq !== null) unreconciledSeqs.add(inflightSeq);
    // O grupo inteiro acaba com o filho: nenhum descendente segue com a
    // credencial de inferência no env.
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // grupo já vazio
      }
    }
    osExitD.resolve();
  }

  let finalizing = false;
  async function finalize(): Promise<void> {
    if (finalizing) return;
    finalizing = true;
    markOsExit();
    feed(splitter.end());
    // Os frames finais (um `result` colado ao exit) são processados; um hook
    // pendurado não segura o fim além do seu próprio teto.
    await Promise.race([chain, sleep(config.hook_timeout_ms + 100)]);
    processGone = true;
    for (const t of timers) clearTimeout(t);
    clearInterval(watchdog);

    if (terminal === null) {
      executorState = cancel !== null ? 'cancelled' : 'unknown';
    }
    if (readiness === 'pending') {
      readiness = 'refused';
      readinessRefusal = cancel !== null ? 'cancelled_before_ready' : 'exited_before_ready';
      readyD.resolve({ kind: 'refused', reason: readinessRefusal, exit_confirmed: true });
    }
    // Pipe perdido = autoridade perdida: o journal também fica sabendo.
    if (!journalRevoked && terminal === null) {
      await revokeInJournal('worker_exited');
    }

    // Evidência mínima (só nomes) ANTES de apagar; o filho já não escreve.
    const inventory = await inventoryHome(home).catch((): string[] => []);
    const removed = await rm(home, { recursive: true, force: true, maxRetries: 3 }).then(
      () => true,
      () => false,
    );
    exitReport = {
      code: exitCode,
      signal: exitSignal,
      home_removed: removed,
      home_inventory: inventory,
      stderr_bytes: stderrBytes,
    };
    exitedD.resolve(exitReport);
    const retention = setTimeout(() => {
      args.onRelease();
      releasedD.resolve();
    }, config.session_retention_ms);
    retention.unref?.();
  }

  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    markOsExit();
    // `close` espera os pipes; um neto que herde o stdout não pode segurar a
    // finalização para sempre.
    const t = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      void finalize();
    }, CLOSE_AFTER_EXIT_MS);
    t.unref?.();
  });
  child.on('close', () => void finalize());
  child.on('error', () => {
    // Erro de sinal/kill depois do spawn: `exit`/`close` decidem o fim.
  });

  // ── prazo: watchdog independente do pipe (§5.8.1) ──
  const watchdog = setInterval(() => {
    if (osExited) return;
    const t = now();
    const lease = leaseHorizon(t);
    const posture = deadlinePosture({
      now_ms: t,
      execution_deadline_ms: spec.execution_deadline_ms,
      lease_horizon_ms: Number.isFinite(lease) ? lease : Number.MAX_SAFE_INTEGER,
      grace_ms: config.cancel_grace_ms,
    });
    if (posture === 'within_deadline') return;
    void requestCancel(timeExpired() ?? 'deadline');
    // Escada travada não mantém processo vivo.
    if (posture === 'kill_due') killWorker(child);
  }, config.watchdog_interval_ms);
  watchdog.unref?.();

  // ── ready com prazo ──
  arm(() => {
    if (readiness === 'pending') refuseReadiness('ready_timeout', 'policy');
  }, config.ready_timeout_ms);

  // ── posse do dono ──
  const onAbort = (): void => {
    if (readiness === 'pending') refuseReadiness('cancelled_before_ready', 'ownership_lost');
    else void requestCancel('ownership_lost');
  };
  if (spec.signal.aborted) onAbort();
  else spec.signal.addEventListener('abort', onAbort, { once: true });
  void exitedD.promise.then(() => spec.signal.removeEventListener('abort', onAbort));

  // ── o `start`, uma vez ──
  try {
    child.stdin.write(args.startLine);
  } catch {
    pipeBroken = true;
  }

  return {
    run_id,
    worker_instance_id,
    ready: readyD.promise,
    exited: exitedD.promise,
    released: releasedD.promise,
    get cancellation() {
      return cancellation;
    },
    requestCancel,
    snapshot: () => ({
      run_id,
      worker_instance_id,
      supervisor_incarnation: args.incarnation,
      pid: typeof child.pid === 'number' ? child.pid : null,
      readiness,
      readiness_refusal: readinessRefusal,
      executor_state: executorState,
      capabilities_revoked: capabilitiesRevoked,
      cancel: cancel ? { ...cancel } : null,
      terminal: terminal ? { ...terminal } : null,
      protocol_violation: protocolViolation,
      forwarded_calls: forwardedCalls,
      unreconciled_calls: unreconciledSeqs.size,
      locally_refused_call_seqs: refusedOnlyLocally(),
      exit: exitReport,
    }),
  };
}
