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
 * Estados que OCUPAM a stream: enquanto um turno está em um deles, nenhum outro
 * turno da mesma stream pode ser reivindicado (issue #625, fatia B da #505).
 *
 * É a MESMA lista de `LEASE_TAKEOVER_STATUSES`, e a igualdade não é
 * coincidência: um turno ocupa a stream exatamente enquanto pode ter dono vivo.
 * Ainda assim são constantes SEPARADAS, porque respondem a perguntas
 * diferentes — "de quais estados se pode tomar posse?" e "quais estados
 * bloqueiam a stream?" — e uma fatia futura pode mover uma sem mover a outra
 * (incluir `outbound_pending` aqui, por exemplo, prenderia a stream pela
 * latência do provedor de saída sem torná-la reivindicável).
 *
 * ESTA LISTA ESPELHA O PREDICADO DO ÍNDICE `agent_turns_stream_active_uq`
 * (migration 124). Mudar uma sem a outra faz a exclusão do banco e a
 * recuperação da aplicação discordarem — e a forma dessa discordância é uma
 * stream travada. `tests/unit/runtime/stream-exclusion-contract.spec.ts` amarra
 * as duas ao mesmo texto.
 */
export const STREAM_OCCUPYING_STATUSES = ['claimed', 'running'] as const;

/** Nome do índice único parcial que garante a exclusão NO BANCO. */
export const STREAM_EXCLUSION_CONSTRAINT = 'agent_turns_stream_active_uq';

/**
 * #626 — nome do índice PARCIAL que sustenta a pergunta do head-of-line
 * ("existe turno anterior não terminal nesta stream?", migration 126).
 *
 * Ele não DECIDE nada — quem decide é o `NOT EXISTS` de
 * `src/db/repositories/stream-head-sql.ts`. Ele decide o CUSTO, e é por isso
 * que o nome mora no vocabulário e não só no arquivo de migration: sem ele a
 * regra continua correta e passa a varrer o histórico inteiro de uma conversa
 * quente a cada claim — a degradação que a issue nomeia ("`NOT EXISTS` sem o
 * índice certo degrada rápido"). O runbook §11.4 usa este nome para checar
 * `pg_index.indisvalid`.
 */
export const STREAM_HEAD_OF_LINE_INDEX = 'agent_turns_stream_head_live_idx';

/**
 * #626 — VOCABULÁRIO ÚNICO dos resultados do escalonamento por stream.
 *
 * A issue pede "códigos de resultado centralizados: `not_head`, `stream_busy`,
 * `eligible`, `stream_blocked`, `promoted`". Centralizar não é catalogar: é
 * fazer com que nenhuma camada possa inventar um sexto código nem grafar um
 * dos cinco de outro jeito. Métrica, `audit_log`, log e o tipo de retorno saem
 * todos daqui, e `tests/unit/runtime/stream-head-of-line-contract.spec.ts`
 * fixa o conjunto — acrescentar um código sem tocar no teste é impossível.
 *
 * Quem PRODUZ cada um, hoje:
 *
 * | código | quem produz | significado |
 * |---|---|---|
 * | `eligible` | `claimNextEligibleTurn` (caminho de sucesso) | o turno É o head-of-line da stream e o claim foi concedido |
 * | `not_head` | `claimNextEligibleTurn` (recusa) | existe turno ANTERIOR não terminal na mesma stream, e ele avança sozinho |
 * | `stream_blocked` | `claimNextEligibleTurn` (recusa) | o anterior está em `outbound_pending`: NENHUM claim o move, quem o move é o delivery worker (#506) |
 * | `stream_busy` | o índice `agent_turns_stream_active_uq` (#625) | outro turno da stream já está ATIVO com lease viva |
 * | `promoted` | **ninguém ainda** — #627 | o sucessor foi promovido/enfileirado quando o head chegou a terminal |
 *
 * `promoted` entra agora, sem produtor, deliberadamente. A alternativa era a
 * #627 acrescentar um sexto rótulo a uma série de métrica já em uso — e
 * mudar o domínio de um label depois que ele está num dashboard é a forma mais
 * fácil de quebrar um alerta sem ninguém perceber. Uma série que existe em
 * zero é barata; um vocabulário que muda debaixo do painel, não.
 */
export const STREAM_SCHEDULING_RESULTS = [
  'eligible',
  'not_head',
  'stream_blocked',
  'stream_busy',
  'promoted',
] as const;

export type StreamSchedulingResult = (typeof STREAM_SCHEDULING_RESULTS)[number];

/**
 * #626 — os motivos de BLOQUEIO da stream, o subconjunto de
 * `STREAM_SCHEDULING_RESULTS` que vira label de
 * `maia_stream_blocked_total{reason}`.
 *
 * `eligible` e `promoted` ficam de fora porque não são bloqueio; contá-los ali
 * transformaria um contador de "quanto a fila segurou" num contador de tráfego.
 */
export const STREAM_BLOCKED_REASONS = ['not_head', 'stream_blocked', 'stream_busy'] as const;

export type StreamBlockedReason = (typeof STREAM_BLOCKED_REASONS)[number];

/**
 * #626 — onde uma violação de FIFO pode ser DETECTADA.
 *
 * `maia_stream_fifo_violation_total{stage}` é, pela issue, "sempre zero" — e um
 * contador que ninguém sabe incrementar também é sempre zero, sem provar nada.
 * Cada estágio aqui é um detector REAL, e a pergunta que ele responde é
 * diferente:
 *
 *  - `claim` — PÓS-CONDIÇÃO dentro da transação do claim concedido: o turno que
 *    acabou de ser reivindicado tinha, mesmo assim, um anterior não terminal na
 *    stream. Acusa a regra não ter sido aplicada (removida do `WHERE`, aplicada
 *    à linha errada, índice e código discordando);
 *  - `recovery` — o varredor rearmou um turno que não era o head-of-line.
 *    Acusa a divergência que a issue nomeia por escrito: "duas cópias da regra
 *    de elegibilidade divergem, e a divergência só aparece durante um recovery".
 */
export const STREAM_FIFO_VIOLATION_STAGES = ['claim', 'recovery'] as const;

export type StreamFifoViolationStage = (typeof STREAM_FIFO_VIOLATION_STAGES)[number];

/**
 * Resultado TIPADO de uma tentativa de claim. `not_claimed` NÃO é erro: é a
 * resposta correta para "outro worker chegou primeiro" e para "ainda não está
 * elegível". O que ele nunca é: autorização para processar.
 *
 * `recovered_stream_claims` (#625) carrega os turnos da MESMA stream cujo claim
 * expirado foi recuperado DENTRO da transação deste claim. Vem nos dois ramos
 * de propósito: a recuperação acontece antes de sabermos se venceremos a
 * corrida, e quem perdeu ainda precisa relatar que desbloqueou a stream. Vazio
 * é o caso normal.
 */
export type ClaimResult =
  | {
      ok: true;
      claim: TurnClaim;
      recovered_stream_claims?: readonly string[];
      /**
       * #626 — o CANÁRIO disparou: o claim foi concedido e, ainda assim, havia
       * turno anterior não terminal na stream. Presente só na anomalia.
       *
       * Vem no resultado em vez de virar log dentro do repositório pela mesma
       * razão de `recovered_stream_claims`: o repositório é puro-DB, e `audit()`
       * lá fecharia o ciclo de import governance/audit -> repositories. Quem
       * relata é `src/runtime/turns/lease.ts`.
       */
      fifo_violation?: { stage: StreamFifoViolationStage; earlier_live: number };
    }
  | {
      ok: false;
      reason: ClaimRejection;
      recovered_stream_claims?: readonly string[];
      /**
       * #626 — QUEM está na frente, quando a recusa é `not_head` ou
       * `stream_blocked`. Diagnóstico, nunca instrução: esta fatia NÃO
       * enfileira o bloqueador (promoção é #627), e agir sobre ele aqui
       * transformaria um claim recusado em escrita num turno alheio.
       *
       * Sem este campo, "a conversa parou" e "a conversa parou por causa DAQUELE
       * turno" seriam o mesmo log, e o operador teria de reconstruir a fila à
       * mão a partir da `stream_key` — que é justamente o dado que a issue-mãe
       * restringe.
       */
      head_block?: { turn_id: string; status: TurnStatus };
    };

/** Por que o claim não foi concedido — label de métrica, cardinalidade fechada. */
export const CLAIM_REJECTIONS = [
  /** A row não existe NO ESCOPO (tenant+agent) corrente. */
  'not_found',
  /** Existe, mas outro worker tem lease viva — ou o estado não é elegível. */
  'not_eligible',
  /**
   * #625 — o turno estava elegível, mas OUTRO turno da mesma stream já está
   * ativo com lease viva, e o banco recusou o segundo claim.
   *
   * Deliberadamente distinto de `not_eligible`. `not_eligible` fala do TURNO
   * ("este aqui não pode ser reivindicado agora"); `stream_busy` fala da
   * STREAM ("a conversa está ocupada por outro turno"). A reação operacional é
   * a mesma — parar —, mas o diagnóstico é oposto: `not_eligible` em massa é
   * problema de roteamento ou de backoff, `stream_busy` em massa é uma
   * conversa serializando, que é o sintoma que a issue-mãe manda vigiar
   * (§Risk: "índice inadequado pode serializar hot streams").
   */
  'stream_busy',
  /**
   * #626 — o turno NÃO é o head-of-line: existe turno ANTERIOR não terminal na
   * mesma stream (`first_ingress_seq` menor).
   *
   * Distinto de `stream_busy` porque as perguntas são diferentes e as
   * remediações também. `stream_busy` é "a conversa está OCUPADA agora" — o
   * anterior tem lease viva e está executando; some sozinho quando ele termina.
   * `not_head` é "a conversa tem FILA" — o anterior pode estar apenas
   * `received`, sem ninguém tê-lo tocado. Colapsar os dois esconderia o caso em
   * que a fila cresce sem nada estar executando, que é o sintoma de starvation
   * que a issue-mãe manda vigiar.
   */
  'not_head',
  /**
   * #626 — o turno anterior está em `outbound_pending`: a stream não avança por
   * escalonamento nenhum.
   *
   * É a recusa que NÃO se resolve com tempo nem com outro worker. Quem tira um
   * turno de `outbound_pending` é o delivery worker do outbox (#506); enquanto
   * ele não o fizer, todo claim desta stream continuará sendo recusado. Por
   * isso não é `not_head`: a leitura operacional de `not_head` é "espere", e a
   * de `stream_blocked` é "vá ao runbook do outbox".
   */
  'stream_blocked',
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
