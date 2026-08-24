/**
 * Issue #510 — `ProcessSupervisor`: processos filhos DE VERDADE, e hard kill
 * por PID exato.
 *
 * ─── O buraco que isto fecha ─────────────────────────────────────────────────
 *
 * As suítes de #504 hoje simulam réplicas concorrentes DENTRO de um processo,
 * com `worker_id` distinto. Isso prova a lógica do claim e não prova nada sobre
 * perda abrupta: um `throw` simulado ainda roda `finally`, ainda fecha o pool,
 * ainda deixa o `heartbeat` cancelar o timer. Um `SIGKILL` não roda nada disso
 * — é exatamente por isso que ele é o teste, e é exatamente isso que não existe
 * no repositório hoje.
 *
 * `FEATURE_TURN_CLAIM` tem default `false` (`src/config/contract.ts:1615`).
 * Ligar esse claim em produção sem prova de sobrevivência a `SIGKILL` é o risco
 * que este supervisor existe para remover.
 *
 * ─── A regra de segurança, e por que ela é assim ─────────────────────────────
 *
 * A issue proíbe nominalmente matar por glob ou por nome de processo. Aqui a
 * proibição é estrutural: `hardKill` só aceita um PID que ESTE supervisor
 * criou, e o registro é a única fonte. Não existe `pkill`, não existe
 * `killall`, não existe varredura de `/proc`. Um PID que o supervisor não
 * conhece produz `ForeignPidError` — e o self-test prova que o processo alheio
 * continua vivo depois da recusa.
 *
 * Há uma segunda tranca, menos óbvia e igualmente necessária: **reuso de PID**.
 * Um filho que já morreu libera o número, e o sistema operacional pode
 * reatribuí-lo a qualquer processo em segundos. Matar "o PID que era do nosso
 * filho" depois que ele morreu é justamente como um harness mata algo alheio
 * sem nunca usar glob. Por isso o registro guarda o estado de saída, e um
 * `hardKill` sobre um filho já encerrado é recusado em vez de virar um
 * `process.kill` cego.
 *
 * ─── Saída inesperada ────────────────────────────────────────────────────────
 *
 * Um filho que morre sem o cenário ter pedido é uma FALHA do cenário, não um
 * evento a ignorar. O supervisor mantém um `AbortController`: qualquer saída
 * não autorizada o dispara, e todo `eventually` que recebeu `abortSignal` para
 * na hora, com o diagnóstico dizendo qual filho morreu e com que sinal — em vez
 * de queimar o prazo inteiro esperando por um estado que ninguém mais vai
 * produzir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { ArtifactCollector } from './artifacts.js';
import { sanitizarTexto } from './sanitize.js';

/** Prefixo da linha estruturada que o filho imprime quando está pronto. */
export const LINHA_PRONTO = '##harness-ready##';
/** Prefixo da linha estruturada de um erro fatal anunciado pelo filho. */
export const LINHA_FATAL = '##harness-fatal##';

export interface SpawnOptions {
  /** Rótulo do cenário para este filho (`worker-a`, `provider`). Único no supervisor. */
  label: string;
  /** Caminho ABSOLUTO do entrypoint. */
  script: string;
  args?: readonly string[];
  /**
   * Ambiente do filho. É MESCLADO ao `process.env` do harness — um filho que
   * não herda `PATH`/`NODE_OPTIONS` não sobe. Passe `undefined` num valor para
   * apagá-lo.
   */
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Default `process.execPath` — o mesmo Node que roda a suíte. */
  execPath?: string;
  /** Prazo para a linha `##harness-ready##`. Default 15s (import a frio custa caro). */
  readyTimeoutMs?: number;
}

export interface Encerramento {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ForeignPidError extends Error {
  constructor(pid: number, conhecidos: readonly number[]) {
    super(
      `Recusado: PID ${pid} não foi criado por este ProcessSupervisor. ` +
        `PIDs sob posse: ${conhecidos.length === 0 ? '(nenhum)' : conhecidos.join(', ')}. ` +
        'O harness NUNCA mata por nome, glob ou varredura — só PID próprio e vivo.',
    );
    this.name = 'ForeignPidError';
  }
}

export class SaidaInesperadaError extends Error {
  constructor(label: string, enc: Encerramento, stderr: string) {
    super(
      `O processo "${label}" encerrou sem o cenário ter pedido ` +
        `(code=${String(enc.code)}, signal=${String(enc.signal)}). ` +
        `Últimas linhas de stderr: ${stderr.trim().split('\n').slice(-8).join(' | ') || '(vazio)'}`,
    );
    this.name = 'SaidaInesperadaError';
  }
}

export class ProntidaoTimeoutError extends Error {
  constructor(label: string, timeoutMs: number, stdout: string, stderr: string) {
    super(
      `O processo "${label}" não anunciou "${LINHA_PRONTO}" em ${timeoutMs}ms. ` +
        `stdout: ${stdout.trim().split('\n').slice(-5).join(' | ') || '(vazio)'}. ` +
        `stderr: ${stderr.trim().split('\n').slice(-5).join(' | ') || '(vazio)'}.`,
    );
    this.name = 'ProntidaoTimeoutError';
  }
}

/** Um filho sob supervisão. Só o supervisor cria. */
export class SupervisedChild {
  readonly label: string;
  /** PID capturado NO SPAWN. É este número, e nenhum outro, que `hardKill` aceita. */
  readonly pid: number;

  /** @internal */ readonly proc: ChildProcess;
  /** @internal */ stdout = '';
  /** @internal */ stderr = '';
  /** @internal */ encerramento: Encerramento | undefined;
  /** @internal */ saidaAutorizada = false;

  private prontoResolve: ((p: Record<string, unknown>) => void) | undefined;
  private prontoReject: ((e: Error) => void) | undefined;
  private readonly prontoPromise: Promise<Record<string, unknown>>;
  private prontoCarga: Record<string, unknown> | undefined;
  private readonly saidaPromise: Promise<Encerramento>;
  private saidaResolve: ((e: Encerramento) => void) | undefined;

  constructor(label: string, proc: ChildProcess) {
    this.label = label;
    if (typeof proc.pid !== 'number') {
      throw new Error(`spawn de "${label}" não produziu PID — o processo não subiu.`);
    }
    this.pid = proc.pid;
    this.proc = proc;
    this.prontoPromise = new Promise((res, rej) => {
      this.prontoResolve = res;
      this.prontoReject = rej;
    });
    // Sem `catch` a promise de prontidão vira unhandled rejection quando o
    // cenário nunca a espera (o caso de um filho que só precisa existir).
    this.prontoPromise.catch(() => undefined);
    this.saidaPromise = new Promise((res) => {
      this.saidaResolve = res;
    });
  }

  /** Vivo = ainda não observamos `exit`. */
  get vivo(): boolean {
    return this.encerramento === undefined;
  }

  /** @internal */ marcarPronto(carga: Record<string, unknown>): void {
    this.prontoCarga = carga;
    this.prontoResolve?.(carga);
  }

  /** @internal */ falharProntidao(erro: Error): void {
    this.prontoReject?.(erro);
  }

  /** @internal */ marcarEncerrado(enc: Encerramento): void {
    this.encerramento = enc;
    this.saidaResolve?.(enc);
    this.prontoReject?.(new SaidaInesperadaError(this.label, enc, this.stderr));
  }

  /**
   * Autoriza a próxima saída. Chamado ANTES de `terminate`/`hardKill` — sem
   * isso, a morte que o próprio cenário causou dispararia o abort de falha.
   */
  autorizarSaida(): void {
    this.saidaAutorizada = true;
  }

  /** A carga do handshake de prontidão, com prazo e diagnóstico. */
  async esperarPronto(timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.prontoCarga) return this.prontoCarga;
    let timer: NodeJS.Timeout | undefined;
    const prazo = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(new ProntidaoTimeoutError(this.label, timeoutMs, this.stdout, this.stderr)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([this.prontoPromise, prazo]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Espera o `exit`. Estoura com diagnóstico se o filho não morrer no prazo. */
  async esperarSaida(timeoutMs = 10_000): Promise<Encerramento> {
    if (this.encerramento) return this.encerramento;
    let timer: NodeJS.Timeout | undefined;
    const prazo = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new Error(
              `O processo "${this.label}" (pid ${this.pid}) não encerrou em ${timeoutMs}ms. ` +
                `stderr: ${this.stderr.trim().split('\n').slice(-5).join(' | ') || '(vazio)'}`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([this.saidaPromise, prazo]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class ProcessSupervisor {
  private readonly porLabel = new Map<string, SupervisedChild>();
  private readonly porPid = new Map<number, SupervisedChild>();
  private readonly abort = new AbortController();
  private descartado = false;
  private readonly artefatos: ArtifactCollector | undefined;
  /** Primeira saída inesperada observada — a causa que o cenário deve reportar. */
  falhaInesperada: SaidaInesperadaError | undefined;
  /**
   * Quantas vezes o corpo de `dispose()` REALMENTE rodou. É a forma observável
   * da idempotência — ver o comentário sobre ela em `dispose()`.
   */
  execucoesDeDispose = 0;

  constructor(artefatos?: ArtifactCollector) {
    this.artefatos = artefatos;
  }

  /**
   * Aborta no instante em que um filho morre sem autorização. Passe para
   * `eventually({ abortSignal })` — é o que transforma "esperei 30s e nada
   * aconteceu" em "o worker-a morreu com SIGSEGV aos 400ms".
   */
  get sinalDeFalha(): AbortSignal {
    return this.abort.signal;
  }

  /** Reprova o cenário se algum filho já morreu sem autorização. */
  assertNenhumaSaidaInesperada(): void {
    if (this.falhaInesperada) throw this.falhaInesperada;
  }

  spawn(opts: SpawnOptions): SupervisedChild {
    if (this.descartado) throw new Error('ProcessSupervisor já foi descartado.');
    if (this.porLabel.has(opts.label)) {
      throw new Error(
        `Já existe um processo com label "${opts.label}". Labels são a identidade do filho ` +
          'no artefato e na timeline; dois filhos com o mesmo label tornam o vermelho ilegível.',
      );
    }

    const proc = spawn(opts.execPath ?? process.execPath, [opts.script, ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // `pipe` nos três: precisamos de stdout (handshake), stderr (diagnóstico)
      // e stdin fechado para que o filho não fique esperando entrada.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Sem `detached`: o filho fica no MESMO grupo de processos, de modo que
      // um `SIGKILL` do harness nunca precise mirar um grupo inteiro (mirar
      // grupo é a porta de entrada para atingir processo alheio).
      detached: false,
    });

    const filho = new SupervisedChild(opts.label, proc);
    this.porLabel.set(opts.label, filho);
    this.porPid.set(filho.pid, filho);
    this.artefatos?.registrarProcesso(opts.label, filho.pid);

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (pedaco: string) => {
      filho.stdout += pedaco;
      this.artefatos?.saidaDeProcesso(opts.label, 'stdout', pedaco);
      this.consumirLinhas(filho, pedaco);
    });
    proc.stderr?.on('data', (pedaco: string) => {
      filho.stderr += pedaco;
      this.artefatos?.saidaDeProcesso(opts.label, 'stderr', pedaco);
    });

    proc.on('error', (erro) => {
      filho.falharProntidao(
        new Error(`spawn de "${opts.label}" falhou: ${sanitizarTexto(erro.message)}`, {
          cause: erro,
        }),
      );
    });

    proc.on('exit', (code, signal) => {
      const enc: Encerramento = { code, signal };
      filho.marcarEncerrado(enc);
      this.artefatos?.saidaDeProcessoEncerrado(opts.label, code, signal);
      if (!filho.saidaAutorizada && !this.descartado) {
        const falha = new SaidaInesperadaError(opts.label, enc, filho.stderr);
        this.falhaInesperada ??= falha;
        this.abort.abort(falha);
      }
    });

    return filho;
  }

  /**
   * Lê as linhas estruturadas do filho. Só duas são protocolo: prontidão e
   * fatal. Todo o resto é log e vai para o artefato como está (sanitizado).
   */
  private consumirLinhas(filho: SupervisedChild, pedaco: string): void {
    for (const linha of pedaco.split('\n')) {
      const t = linha.trim();
      if (t.startsWith(LINHA_PRONTO)) {
        const cru = t.slice(LINHA_PRONTO.length).trim();
        let carga: Record<string, unknown>;
        try {
          carga = cru ? (JSON.parse(cru) as Record<string, unknown>) : {};
        } catch {
          // Um filho que anuncia prontidão com JSON quebrado é um bug DELE, e o
          // cenário precisa ver isso — não pode virar um `esperarPronto` que
          // nunca resolve. A carga marcada é o que o artefato registra.
          carga = { parseError: true, cru };
        }
        this.artefatos?.evento('process.ready', { label: filho.label, pid: filho.pid });
        filho.marcarPronto(carga);
      } else if (t.startsWith(LINHA_FATAL)) {
        this.artefatos?.evento('process.fatal', {
          label: filho.label,
          detalhe: t.slice(LINHA_FATAL.length).trim(),
        });
      }
    }
  }

  porLabelOuFalha(label: string): SupervisedChild {
    const f = this.porLabel.get(label);
    if (!f) throw new Error(`Nenhum processo com label "${label}" neste supervisor.`);
    return f;
  }

  /** PIDs sob posse — a lista fechada que `hardKill` aceita. */
  pidsSobPosse(): number[] {
    return [...this.porPid.entries()].filter(([, f]) => f.vivo).map(([pid]) => pid);
  }

  /**
   * `SIGKILL` no PID EXATO. As duas trancas descritas no cabeçalho:
   *
   *  1. o PID precisa estar no registro deste supervisor;
   *  2. o filho precisa estar VIVO — matar o PID de um filho já encerrado é
   *     como um harness acerta processo alheio sem nunca usar glob.
   *
   * ─── Onde mais este módulo chama `process.kill`, e por que é seguro ───────
   *
   * Existem outros três call sites — o `SIGTERM` de `terminate()` e o par
   * `SIGTERM`/`SIGKILL` de `dispose()`. Nenhum deles aceita PID de fora: os
   * três iteram o REGISTRO deste supervisor (`porLabel`) e checam `.vivo`
   * antes de sinalizar, de modo que as duas trancas valem por construção em
   * vez de por exceção. `hardKill` é o único que recebe um PID como ARGUMENTO,
   * e por isso é o único que precisa recusar explicitamente — a escalada para
   * `SIGKILL` de `terminate()` passa por ele.
   */
  hardKill(alvo: SupervisedChild | number): void {
    const pid = typeof alvo === 'number' ? alvo : alvo.pid;
    const filho = this.porPid.get(pid);
    if (!filho) throw new ForeignPidError(pid, [...this.porPid.keys()]);
    if (!filho.vivo) {
      throw new Error(
        `Recusado: o filho "${filho.label}" (pid ${pid}) já encerrou ` +
          `(code=${String(filho.encerramento?.code)}, signal=${String(filho.encerramento?.signal)}). ` +
          'O sistema operacional pode ter reatribuído esse PID; matá-lo agora atingiria outro processo.',
      );
    }
    filho.autorizarSaida();
    this.artefatos?.evento('process.hard_kill', { label: filho.label, pid });
    process.kill(pid, 'SIGKILL');
  }

  /**
   * Encerramento GRACIOSO: `SIGTERM`, espera `graceMs`, e só então `SIGKILL`
   * — pelo mesmo caminho guardado acima.
   */
  async terminate(alvo: SupervisedChild | string, graceMs = 5_000): Promise<Encerramento> {
    const filho = typeof alvo === 'string' ? this.porLabelOuFalha(alvo) : alvo;
    if (!filho.vivo) return filho.encerramento as Encerramento;
    filho.autorizarSaida();
    this.artefatos?.evento('process.sigterm', { label: filho.label, pid: filho.pid });
    process.kill(filho.pid, 'SIGTERM');
    try {
      return await filho.esperarSaida(graceMs);
    } catch {
      if (filho.vivo) this.hardKill(filho);
      return await filho.esperarSaida(2_000);
    }
  }

  /**
   * Teardown IDEMPOTENTE. Chamar duas vezes é um no-op na segunda — o
   * `afterEach` do cenário e o `afterAll` da suíte chamam os dois, e nenhum
   * dos dois deveria precisar saber do outro.
   *
   * Nada aqui joga: um teardown que reprova a suíte esconde a causa real do
   * vermelho. As falhas de teardown vão para a timeline do artefato, que é
   * onde a issue manda mantê-las.
   *
   * ─── Por que a idempotência é CONTADA e não só "não jogou" ────────────────
   *
   * "Chamar duas vezes não joga" é fraco demais para ser garantia: com o guard
   * removido, a segunda chamada também não joga, porque a lista de vivos já
   * está vazia. Ela apenas volta a varrer o registro e a tocar PIDs que o
   * sistema operacional já liberou — o mesmo perigo de reuso que `hardKill`
   * recusa. Por isso `execucoesDeDispose` é um contador observável: o
   * self-test afirma que ele é 1 depois de duas chamadas, e essa afirmação
   * fica vermelha quando o guard sai.
   */
  async dispose(graceMs = 3_000): Promise<void> {
    if (this.descartado) return;
    this.descartado = true;
    this.execucoesDeDispose += 1;
    this.artefatos?.evento('teardown.dispose', { execucao: this.execucoesDeDispose });
    const vivos = [...this.porLabel.values()].filter((f) => f.vivo);
    for (const filho of vivos) {
      filho.autorizarSaida();
      try {
        process.kill(filho.pid, 'SIGTERM');
      } catch (erro) {
        this.artefatos?.evento('teardown.error', {
          label: filho.label,
          etapa: 'sigterm',
          erro: sanitizarTexto(erro instanceof Error ? erro.message : String(erro)),
        });
      }
    }
    for (const filho of vivos) {
      try {
        await filho.esperarSaida(graceMs);
      } catch {
        try {
          if (filho.vivo) process.kill(filho.pid, 'SIGKILL');
          await filho.esperarSaida(2_000);
        } catch (erro) {
          this.artefatos?.evento('teardown.error', {
            label: filho.label,
            etapa: 'sigkill',
            erro: sanitizarTexto(erro instanceof Error ? erro.message : String(erro)),
          });
        }
      }
    }
  }
}
