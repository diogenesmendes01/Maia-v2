/**
 * Issue #510 — catálogo TIPADO de failpoints e o gate determinístico.
 *
 * ─── O que é um failpoint aqui ───────────────────────────────────────────────
 *
 * Um ponto NOMEADO do caminho de execução onde o cenário pode pausar, errar,
 * desconectar ou matar o processo. Ele não é um mock: o código de produção
 * continua sendo o mesmo; o failpoint só decide QUANDO o cenário observa e
 * intervém.
 *
 * ─── Por que o catálogo mora em `tests/` e não em `src/` ─────────────────────
 *
 * `tsconfig.json` tem `include: ["src/**\/*"]` e `exclude: [..., "tests"]`. Um
 * módulo daqui NÃO entra em `dist/`, então não existe caminho pelo qual um
 * binário de produção carregue este arquivo. Essa é a garantia mais forte
 * disponível: não é uma flag desligada, é código ausente do artefato.
 *
 * A garantia é verificável e está verificada — `self-tests/failpoints.spec.ts`
 * afirma que nenhum arquivo de `src/` importa este módulo nem menciona
 * qualquer nome do catálogo, e que o `tsconfig` continua excluindo `tests/`.
 * Se alguém um dia mover a injeção para dentro de `src/`, o teste arquitetural
 * fica vermelho ANTES de o código chegar a produção.
 *
 * ─── E a segunda tranca ──────────────────────────────────────────────────────
 *
 * Ainda assim, um harness que fosse carregado por engano num processo de
 * produção (por um `tsx tests/...` num container errado) não pode armar nada.
 * Por isso `assertFailpointsAllowed()` recusa em três condições independentes,
 * e a recusa por perfil de produção NÃO tem opt-out: nem token, nem variável,
 * nem argumento a desliga.
 *
 * ─── A armadilha de namespace de env (#498) ──────────────────────────────────
 *
 * `src/config/validate.ts:249` REJEITA qualquer chave `MAIA_*`/`FEATURE_*` que
 * não exista no contrato. Uma variável no `env:` de um job do CI alcança TODO
 * processo daquele job — inclusive os que validam o contrato. Por isso as
 * chaves deste harness usam o prefixo NEUTRO `TEST_`, que o contrato ignora
 * por construção. Nada aqui exige mudança em `src/config/contract.ts`.
 */
import { z } from 'zod';

/**
 * Os 16 failpoints que a issue #510 exige nominalmente, na ordem do caminho de
 * execução de um turno. A ordem é documental; nada depende dela.
 *
 * Nenhum cenário FI-01..FI-25 é implementado nesta fatia — o catálogo existe
 * para que os cenários futuros não inventem nomes soltos, e para que o teste
 * arquitetural tenha uma lista fechada contra a qual varrer `src/`.
 */
export const FAILPOINTS = [
  'after_inbound_persist_before_enqueue',
  'after_enqueue_before_handler_return',
  'after_turn_claim_before_running',
  'after_running_before_llm',
  'during_llm_request',
  'after_llm_before_tool',
  'after_tool_authorized_before_effect',
  'after_tool_effect_before_result_persist',
  'after_response_built_before_outbox_commit',
  'after_outbox_commit_before_delivery_enqueue',
  'after_outbound_claim_before_send',
  'after_provider_accept_before_delivery_persist',
  'after_delivery_persist_before_turn_complete',
  'during_lease_heartbeat',
  'before_successor_promotion',
  'after_successor_promotion_before_enqueue',
] as const;

export type FailpointName = (typeof FAILPOINTS)[number];

/** Zod é a fronteira de entrada: nada vira `FailpointName` sem passar por aqui. */
export const failpointNameSchema = z.enum(FAILPOINTS);

/**
 * Ações que o cenário pode armar num failpoint. `release` é o default implícito
 * (segue em frente assim que o harness liberar).
 */
export const FAILPOINT_ACTIONS = ['pause', 'error', 'disconnect', 'kill'] as const;
export type FailpointAction = (typeof FAILPOINT_ACTIONS)[number];
export const failpointActionSchema = z.enum(FAILPOINT_ACTIONS);

/**
 * Chave que LIGA a injeção no processo filho. Prefixo `TEST_` de propósito —
 * ver o cabeçalho sobre a armadilha de namespace.
 */
export const FAILPOINT_ENABLE_ENV = 'TEST_RELIABILITY_FAILPOINTS';

/**
 * Token por processo. Ele não protege contra um atacante (é env local); ele
 * protege contra ACIDENTE: um processo que herdou `TEST_RELIABILITY_FAILPOINTS`
 * do ambiente de um job, mas não o token que ESTE harness sorteou, não arma
 * nada e diz por quê.
 */
export const FAILPOINT_TOKEN_ENV = 'TEST_RELIABILITY_FAILPOINT_TOKEN';

/** Onde o filho anuncia `reached` e escuta liberação. Preenchido pelo supervisor. */
export const FAILPOINT_ENDPOINT_ENV = 'TEST_RELIABILITY_FAILPOINT_URL';

/** Prefixo comum — o que o teste arquitetural varre em `src/`. */
export const FAILPOINT_ENV_PREFIX = 'TEST_RELIABILITY_';

/**
 * Erro de catálogo: nome que não existe. Separado de `Error` para que o
 * cenário possa distinguir "escrevi errado" de "o handshake falhou".
 */
export class UnknownFailpointError extends Error {
  readonly candidato: string;
  constructor(candidato: string) {
    super(
      `Failpoint desconhecido: ${JSON.stringify(candidato)}. ` +
        `O catálogo tem ${FAILPOINTS.length} nomes e é fechado: ${FAILPOINTS.join(', ')}.`,
    );
    this.name = 'UnknownFailpointError';
    this.candidato = candidato;
  }
}

/** Recusa de segurança. Nunca é capturada pelo harness — o cenário morre aqui. */
export class FailpointsForbiddenError extends Error {
  constructor(motivo: string) {
    super(`Failpoints recusados: ${motivo}`);
    this.name = 'FailpointsForbiddenError';
  }
}

/**
 * Converte string arbitrária em `FailpointName` — ou falha CEDO, com a lista.
 *
 * Este é o ponto único de entrada do catálogo. `arm()` e o cliente do processo
 * filho passam por aqui, então um nome inexistente reprova no momento em que o
 * cenário é escrito, e não trinta segundos depois num `eventually` que nunca
 * observa `reached`.
 */
export function parseFailpointName(candidato: string): FailpointName {
  const r = failpointNameSchema.safeParse(candidato);
  if (!r.success) throw new UnknownFailpointError(candidato);
  return r.data;
}

export type AmbienteBruto = Readonly<Record<string, string | undefined>>;

/**
 * Perfil de produção, lido de forma redundante: `MAIA_ENV` é o que o contrato
 * de configuração usa (`src/config/contract.ts`), `NODE_ENV` é o que o Node e
 * metade das libs usam. Qualquer um dos dois em `production` fecha a porta.
 */
export function ehPerfilDeProducao(env: AmbienteBruto = process.env): boolean {
  return env.MAIA_ENV === 'production' || env.NODE_ENV === 'production';
}

/**
 * A porta. Retorna `void` e joga — chamador nenhum precisa lembrar de checar
 * um booleano.
 *
 * As três condições são independentes e a ORDEM importa: produção é avaliada
 * PRIMEIRO, de modo que a mensagem de erro nunca sugira "faltou o token" quando
 * o problema real é o perfil. Não existe argumento, flag ou token que pule esta
 * primeira condição.
 */
export function assertFailpointsAllowed(
  env: AmbienteBruto = process.env,
  tokenEsperado?: string,
): void {
  if (ehPerfilDeProducao(env)) {
    throw new FailpointsForbiddenError(
      'o processo está em perfil de produção (MAIA_ENV/NODE_ENV = production). ' +
        'Não há opt-out: o harness de fault injection nunca arma em produção.',
    );
  }
  if (env[FAILPOINT_ENABLE_ENV] !== '1') {
    throw new FailpointsForbiddenError(
      `${FAILPOINT_ENABLE_ENV} não está em "1". Failpoints são desabilitados por default.`,
    );
  }
  const token = env[FAILPOINT_TOKEN_ENV];
  if (!token || token.length < 8) {
    throw new FailpointsForbiddenError(
      `${FAILPOINT_TOKEN_ENV} ausente ou curto demais. O token é sorteado por rodada pelo harness.`,
    );
  }
  if (tokenEsperado !== undefined && token !== tokenEsperado) {
    throw new FailpointsForbiddenError(
      'o token do processo não é o desta rodada do harness — o processo herdou o ambiente de outra.',
    );
  }
}

/** Versão booleana, para logs e diagnóstico. Nunca para decidir se arma. */
export function failpointsHabilitados(env: AmbienteBruto = process.env): boolean {
  try {
    assertFailpointsAllowed(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Um gate armado: o que o cenário quer que aconteça quando o processo chegar
 * naquele ponto.
 */
export interface ArmedGate {
  readonly failpoint: FailpointName;
  readonly action: FailpointAction;
  /**
   * Quantas vezes o gate ainda vale. `1` é o default: um gate de uso único
   * evita que um `kill` armado para o primeiro turno derrube o quinto.
   */
  readonly remaining: number;
  /** Timestamp monotônico (ms desde o início do registry) do `arm`. */
  readonly armedAtMs: number;
}

/** O que o processo filho anuncia ao chegar num failpoint. */
export interface ReachedEvent {
  readonly failpoint: FailpointName;
  /** IDs que o cenário validou ao armar (turn_id, attempt, worker_id...). */
  readonly context: Readonly<Record<string, string | number>>;
  readonly reachedAtMs: number;
}

export class DuplicateGateError extends Error {
  constructor(failpoint: FailpointName, existente: ArmedGate, novo: FailpointAction) {
    super(
      `Gate duplicado em "${failpoint}": já existe um gate armado com ação ` +
        `"${existente.action}" (restam ${existente.remaining}) e pediram "${novo}". ` +
        'Dois gates no mesmo failpoint tornam o cenário não determinístico — ' +
        'desarme o anterior (`disarm`) ou use um failpoint distinto.',
    );
    this.name = 'DuplicateGateError';
  }
}

export class HandshakeTimeoutError extends Error {
  /** Diagnóstico estruturado — o `ArtifactCollector` grava isto como está. */
  readonly diagnostico: {
    failpoint: FailpointName;
    timeoutMs: number;
    elapsedMs: number;
    armados: Array<{ failpoint: string; action: string; remaining: number }>;
    alcancados: Array<{ failpoint: string; reachedAtMs: number }>;
  };
  constructor(diagnostico: HandshakeTimeoutError['diagnostico']) {
    super(
      [
        `Handshake do failpoint "${diagnostico.failpoint}" não chegou em ${diagnostico.timeoutMs}ms ` +
          `(esperei ${diagnostico.elapsedMs}ms).`,
        `Gates armados no momento do estouro: ${
          diagnostico.armados.length === 0
            ? '(nenhum)'
            : diagnostico.armados
                .map((g) => `${g.failpoint}:${g.action}x${g.remaining}`)
                .join(', ')
        }.`,
        `Failpoints alcançados nesta rodada: ${
          diagnostico.alcancados.length === 0
            ? '(nenhum — o processo pode nem ter chegado ao caminho, ou não está com a injeção ligada)'
            : diagnostico.alcancados.map((r) => `${r.failpoint}@${r.reachedAtMs}ms`).join(', ')
        }.`,
      ].join(' '),
    );
    this.name = 'HandshakeTimeoutError';
    this.diagnostico = diagnostico;
  }
}

/**
 * O registry de gates do lado do CENÁRIO.
 *
 * Ele é deliberadamente burro e síncrono: arma, recebe `reached`, resolve quem
 * espera. Quem transporta `reached` do processo filho até aqui (IPC, HTTP local)
 * é o `ProcessSupervisor`; separar as duas coisas é o que permite testar o
 * protocolo sem subir processo nenhum.
 */
export class FailpointGateRegistry {
  private readonly gates = new Map<FailpointName, ArmedGate>();
  private readonly alcancados: ReachedEvent[] = [];
  private readonly esperando = new Map<
    FailpointName,
    Array<{ resolve: (e: ReachedEvent) => void }>
  >();
  private readonly t0 = Date.now();

  private agoraMs(): number {
    return Date.now() - this.t0;
  }

  /**
   * Arma um gate. Recusa duplicata — inclusive duplicata IDÊNTICA, porque dois
   * `arm` do mesmo failpoint quase sempre significam dois cenários dividindo um
   * registry por engano, e o segundo silenciosamente herdaria o `remaining` do
   * primeiro.
   */
  arm(failpointBruto: string, action: FailpointAction = 'pause', remaining = 1): ArmedGate {
    const failpoint = parseFailpointName(failpointBruto);
    const existente = this.gates.get(failpoint);
    if (existente) throw new DuplicateGateError(failpoint, existente, action);
    if (!Number.isInteger(remaining) || remaining < 1) {
      throw new RangeError(`remaining precisa ser inteiro >= 1, recebi ${String(remaining)}`);
    }
    const gate: ArmedGate = { failpoint, action, remaining, armedAtMs: this.agoraMs() };
    this.gates.set(failpoint, gate);
    return gate;
  }

  /** Desarma. Idempotente: desarmar o que não existe é `false`, não erro. */
  disarm(failpointBruto: string): boolean {
    return this.gates.delete(parseFailpointName(failpointBruto));
  }

  armado(failpointBruto: string): ArmedGate | undefined {
    return this.gates.get(parseFailpointName(failpointBruto));
  }

  /**
   * Consome o gate para este `reached` e devolve a ação a executar.
   * `undefined` = nenhum gate armado, o processo segue.
   */
  reached(failpointBruto: string, context: Readonly<Record<string, string | number>> = {}): {
    action: FailpointAction | undefined;
    evento: ReachedEvent;
  } {
    const failpoint = parseFailpointName(failpointBruto);
    const evento: ReachedEvent = { failpoint, context, reachedAtMs: this.agoraMs() };
    this.alcancados.push(evento);

    const fila = this.esperando.get(failpoint);
    if (fila) {
      this.esperando.delete(failpoint);
      for (const w of fila) w.resolve(evento);
    }

    const gate = this.gates.get(failpoint);
    if (!gate) return { action: undefined, evento };
    if (gate.remaining <= 1) this.gates.delete(failpoint);
    else this.gates.set(failpoint, { ...gate, remaining: gate.remaining - 1 });
    return { action: gate.action, evento };
  }

  /**
   * Espera o anúncio. Nunca `sleep`: ou o evento chega, ou estoura com
   * diagnóstico que diz o que estava armado e o que foi alcançado.
   *
   * Se o failpoint JÁ foi alcançado antes da espera começar, resolve na hora —
   * do contrário haveria uma corrida entre armar e esperar.
   */
  async waitForReached(
    failpointBruto: string,
    opts: { timeoutMs?: number; desde?: number } = {},
  ): Promise<ReachedEvent> {
    const failpoint = parseFailpointName(failpointBruto);
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const desde = opts.desde ?? 0;
    const inicio = this.agoraMs();

    const jaChegou = this.alcancados.find(
      (e) => e.failpoint === failpoint && e.reachedAtMs >= desde,
    );
    if (jaChegou) return jaChegou;

    return await new Promise<ReachedEvent>((resolve, reject) => {
      const inscricao = { resolve: (_e: ReachedEvent): void => {} };
      const timer = setTimeout(() => {
        const fila = this.esperando.get(failpoint) ?? [];
        this.esperando.set(
          failpoint,
          fila.filter((w) => w !== inscricao),
        );
        reject(
          new HandshakeTimeoutError({
            failpoint,
            timeoutMs,
            elapsedMs: this.agoraMs() - inicio,
            armados: [...this.gates.values()].map((g) => ({
              failpoint: g.failpoint,
              action: g.action,
              remaining: g.remaining,
            })),
            alcancados: this.alcancados.map((e) => ({
              failpoint: e.failpoint,
              reachedAtMs: e.reachedAtMs,
            })),
          }),
        );
      }, timeoutMs);
      // `unref` para que um gate esquecido não segure o processo de teste vivo.
      timer.unref?.();

      inscricao.resolve = (e: ReachedEvent): void => {
        clearTimeout(timer);
        resolve(e);
      };
      const fila = this.esperando.get(failpoint) ?? [];
      fila.push(inscricao);
      this.esperando.set(failpoint, fila);
    });
  }

  /** Tudo que foi alcançado, para a timeline do artefato. */
  timeline(): readonly ReachedEvent[] {
    return [...this.alcancados];
  }

  /** Teardown idempotente: limpa gates e acorda quem espera com erro claro. */
  dispose(): void {
    this.gates.clear();
    this.esperando.clear();
  }
}
