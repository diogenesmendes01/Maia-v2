/**
 * Issue #504 — contrato PURO do claim atômico, do lease e do fencing.
 *
 * Como `contract.ts` (#503), este módulo é deliberadamente sem I/O: sem `db`,
 * sem ALS, sem timers. Ele define o VOCABULÁRIO que o repositório
 * (`src/db/repositories/turn-repos.ts`) executa em SQL e que o controlador de
 * lease (`src/runtime/turns/lease.ts`) orquestra. Isso o torna testável sem
 * Postgres e mantém uma única definição das regras de elegibilidade.
 *
 * ─── Por que o claim NÃO entra na tabela de transições de #503 ───────────────
 *
 * `TURN_TRANSITIONS` descreve arestas que dependem SÓ do estado de origem. As
 * arestas do takeover — `claimed -> claimed` e `running -> claimed` — não são
 * dessas: elas só existem quando `lease_expires_at <= now()`. Enfiá-las na
 * tabela genérica autorizaria `markClaimed` (o caminho legado, sem lease) a
 * rebaixar um turno em execução COM dono vivo, que é exatamente o contrário do
 * que esta issue existe para impedir. Por isso o claim tem tabela própria, e a
 * condição de lease é parte inseparável dela.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TurnStatus } from './contract.js';

/**
 * Estados em que um turno está disponível para um claim NOVO — nenhum worker o
 * possui, ou nunca possuiu.
 *
 * `retryable` entra porque o backoff é do PostgreSQL (`next_attempt_at`), não
 * do BullMQ: um turno em `retryable` cuja tentativa venceu é trabalho legítimo.
 * A checagem de `next_attempt_at` é feita no SQL, não aqui — é uma condição de
 * RELÓGIO, e o relógio autoritativo é o do banco (cláusula da issue: "Relógio
 * usado para elegibilidade deve ser o do PostgreSQL").
 */
export const CLAIMABLE_STATUSES = ['received', 'queued', 'retryable'] as const;

/**
 * Estados em que um turno JÁ TEM dono e só pode ser tomado se a lease venceu.
 *
 * `outbound_pending` está deliberadamente FORA, pela mesma razão de #503: a
 * resposta já foi comprometida e uma segunda execução do ReAct a duplicaria.
 * Um turno preso em `outbound_pending` é problema do outbox (#506), nunca de um
 * takeover.
 */
export const LEASE_TAKEOVER_STATUSES = ['claimed', 'running'] as const;

/** Estados que uma gravação FENCED aceita como origem (o turno é meu e está vivo). */
export const FENCED_WRITE_STATUSES = ['claimed', 'running', 'outbound_pending'] as const;

/**
 * Resultado TIPADO de uma tentativa de claim. `not_claimed` NÃO é erro: é a
 * resposta correta para "outro worker chegou primeiro" e para "ainda não está
 * elegível". O que ele nunca é: autorização para processar.
 */
export type ClaimResult =
  | { ok: true; claim: TurnClaim }
  | { ok: false; reason: ClaimRejection };

/** Por que o claim não foi concedido — label de métrica, cardinalidade fechada. */
export const CLAIM_REJECTIONS = [
  /** A row não existe NO ESCOPO (tenant+agent) corrente. */
  'not_found',
  /** Existe, mas outro worker tem lease viva — ou o estado não é elegível. */
  'not_eligible',
] as const;

export type ClaimRejection = (typeof CLAIM_REJECTIONS)[number];

/** Posse concedida: o que o worker precisa carregar para escrever com fence. */
export type TurnClaim = {
  turn_id: string;
  tenant_id: string;
  agent_id: string;
  /** Tentativa CANÔNICA — vem do PostgreSQL, nunca de `job.attemptsMade`. */
  attempt: number;
  /** O FENCE. Toda gravação da tentativa exige este valor no WHERE. */
  claim_token: string;
  worker_id: string;
  claimed_at: Date;
  lease_expires_at: Date;
  status: TurnStatus;
  state_version: number;
};

/**
 * Contexto de execução propagado pela tentativa (issue §Fencing).
 *
 * `deadline` e `signal` nascem aqui porque o cancelamento por perda de lease é
 * desta issue; o orçamento GLOBAL do turno é #507, que preenche `deadline` com
 * o mínimo entre o vencimento do lease e o seu próprio orçamento.
 */
export type TurnExecutionContext = {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  attempt: number;
  claim_token: string;
  worker_id: string;
  deadline: Date;
  signal: AbortSignal;
};

/** Por que a posse foi perdida — label de métrica. */
export const LEASE_LOSS_REASONS = [
  /** O heartbeat encontrou o turno com outro token (ou nenhum): fomos tomados. */
  'token_mismatch',
  /** O heartbeat falhou repetidamente (banco indisponível) e abortamos ANTES do vencimento. */
  'heartbeat_failed',
  /** A lease venceu sem renovação bem-sucedida. */
  'expired',
  /** Shutdown gracioso: liberamos a posse de propósito. */
  'released',
] as const;

export type LeaseLossReason = (typeof LEASE_LOSS_REASONS)[number];

/** Resultado TIPADO de uma renovação de lease. */
export type LeaseRenewalResult =
  | { ok: true; lease_expires_at: Date; heartbeat_at: Date }
  | { ok: false; reason: 'token_mismatch' };

// ─── Identidade do worker ────────────────────────────────────────────────────

let cachedWorkerId: string | null = null;

/**
 * Identidade ÚNICA e ESTÁVEL deste processo enquanto dono de claims.
 *
 * `<hostname>:<pid>:turn:<rand>`. O sufixo aleatório não é decoração: a issue
 * proíbe explicitamente "usar hostname sozinho como garantia de unicidade", e
 * `hostname:pid` também não basta — o PID é reciclado pelo kernel, e num
 * container que reinicia o processo pode voltar com o MESMO par. Se isso
 * acontecesse, um zumbi da encarnação anterior teria `claimed_by` idêntico ao
 * do sucessor e a trilha de auditoria juntaria dois donos num só.
 *
 * O que impede a escrita do zumbi continua sendo o `claim_token` (fencing), não
 * este id — `claimed_by` é DIAGNÓSTICO. Ainda assim ele precisa distinguir
 * encarnações, senão o diagnóstico mente.
 *
 * Estável durante toda a vida do processo (memoizado) e sem informação
 * sensível: hostname e pid já aparecem em todo log da instalação.
 */
export function turnWorkerId(): string {
  cachedWorkerId ??= `${hostname()}:${process.pid}:turn:${randomUUID().slice(0, 8)}`;
  return cachedWorkerId;
}

/** Só para teste: força uma nova identidade (simula outra réplica). */
export function __resetTurnWorkerIdForTest(): void {
  cachedWorkerId = null;
}

// ─── Aritmética do lease ─────────────────────────────────────────────────────

/**
 * Razão MÁXIMA entre intervalo de heartbeat e TTL do lease (issue §Lease: "o
 * intervalo de heartbeat deve ser no máximo um terço do TTL").
 *
 * Um terço, e não metade, porque com metade UMA renovação perdida já deixa o
 * lease vencer: não há segunda tentativa dentro da janela. Com um terço cabem
 * duas falhas consecutivas antes do vencimento, que é o que transforma um blip
 * de rede num evento invisível em vez de num takeover falso.
 */
export const MAX_HEARTBEAT_TO_TTL_RATIO = 1 / 3;

/**
 * Quantas renovações consecutivas podem falhar antes de abortarmos a tentativa
 * por conta própria.
 *
 * Derivado da razão acima: com heartbeat = TTL/3, a terceira falha consecutiva
 * cai EM CIMA do vencimento. Abortamos na segunda, ainda dentro da janela — a
 * issue exige que "falha repetida de heartbeat deve abortar a tentativa ANTES
 * da expiração", e abortar depois seria escrever com lease vencida.
 */
export const MAX_HEARTBEAT_FAILURES = 2;

export type LeaseTimingCheck =
  | { ok: true }
  | { ok: false; reason: 'ttl_not_positive' | 'heartbeat_not_positive' | 'heartbeat_too_slow' };

/**
 * Valida a relação TTL × heartbeat. FAIL-CLOSED por construção: qualquer
 * combinação que não deixe pelo menos três renovações caberem no TTL é
 * rejeitada, porque ela produz takeover falso sob carga normal — e um takeover
 * falso é DUAS execuções do mesmo turno, o defeito que esta issue fecha.
 *
 * Usada em duas camadas: na regra cross-field do contrato de config (boot) e no
 * construtor do controlador de lease (defesa em profundidade, caso alguém passe
 * valores programaticamente).
 */
export function checkLeaseTiming(ttl_ms: number, heartbeat_ms: number): LeaseTimingCheck {
  if (!Number.isFinite(ttl_ms) || ttl_ms <= 0) return { ok: false, reason: 'ttl_not_positive' };
  if (!Number.isFinite(heartbeat_ms) || heartbeat_ms <= 0) {
    return { ok: false, reason: 'heartbeat_not_positive' };
  }
  if (heartbeat_ms > ttl_ms * MAX_HEARTBEAT_TO_TTL_RATIO) {
    return { ok: false, reason: 'heartbeat_too_slow' };
  }
  return { ok: true };
}

/** Erro FAIL-LOUD de configuração de lease insegura. */
export class UnsafeLeaseTimingError extends Error {
  readonly code = 'UNSAFE_LEASE_TIMING';
  constructor(ttl_ms: number, heartbeat_ms: number, reason: string) {
    super(
      `configuração de lease insegura (ttl_ms=${ttl_ms}, heartbeat_ms=${heartbeat_ms}, ` +
        `motivo=${reason}): o heartbeat precisa caber ao menos 3x no TTL, senão uma ` +
        `renovação perdida já produz takeover falso — e takeover falso é execução dupla`,
    );
    this.name = 'UnsafeLeaseTimingError';
  }
}

export function assertLeaseTiming(ttl_ms: number, heartbeat_ms: number): void {
  const check = checkLeaseTiming(ttl_ms, heartbeat_ms);
  if (!check.ok) throw new UnsafeLeaseTimingError(ttl_ms, heartbeat_ms, check.reason);
}

/**
 * Erro lançado quando uma gravação da tentativa é REJEITADA pelo fence — o
 * turno pertence a outro worker (ou não está mais em estado gravável).
 *
 * É um erro, e não um resultado silencioso, porque o caller que o recebe está
 * no meio de uma tentativa que precisa PARAR. Tratá-lo como `false` produziria
 * o pior dos mundos: o pipeline seguiria adiante achando que gravou.
 */
export class StaleClaimError extends Error {
  readonly code = 'STALE_CLAIM';
  readonly turn_id: string;
  readonly operation: string;
  constructor(args: { turn_id: string; operation: string }) {
    super(
      `stale_claim: a gravação '${args.operation}' do turno ${args.turn_id} foi rejeitada pelo ` +
        `fence — o claim_token não é mais o vigente. A tentativa local perdeu a posse e NÃO ` +
        `pode concluir o turno.`,
    );
    this.name = 'StaleClaimError';
    this.turn_id = args.turn_id;
    this.operation = args.operation;
  }
}
