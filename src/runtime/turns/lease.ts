/**
 * Issue #504 — controlador de POSSE de um turno: claim, heartbeat, perda e
 * liberação.
 *
 * Divisão de trabalho deliberada:
 *   - `claim.ts` define o vocabulário e a aritmética (puro);
 *   - `turn-repos.ts` executa as declarações SQL atômicas (puro-DB);
 *   - **este módulo** é o único que tem TEMPO: liga o timer de heartbeat,
 *     decide quando desistir, aborta a tentativa local e audita a anomalia.
 *
 * Nada aqui decide se um turno DEVE executar — isso é do `lifecycle.ts`. Aqui
 * só se responde "eu ainda sou o dono?", e se responde com o PostgreSQL.
 */
import { config } from '@/config/env.js';
import { agentTurnsRepo } from '@/db/repositories/turn-repos.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import {
  assertLeaseTiming,
  turnWorkerId,
  MAX_HEARTBEAT_FAILURES,
  type ClaimResult,
  type LeaseLossReason,
  type StreamBlockedReason,
  type StreamClaimRecovery,
  type StreamFifoViolationStage,
  type TurnClaim,
  type TurnExecutionContext,
} from './claim.js';
import { signalStreamPromotion } from './stream-promotion.js';
import { recordStreamFifoViolation } from './stream-metrics.js';

/** Claim com lease ligado? (kill switch da issue) */
export function turnClaimEnabled(): boolean {
  return config.FEATURE_TURN_STATE_MACHINE && config.FEATURE_TURN_CLAIM;
}

/**
 * POSSE VIVA de um turno. Enquanto este objeto está `alive`, o processo é o
 * dono da tentativa e pode gravar com o `claim_token`.
 *
 * O ciclo de vida é explícito de propósito — `stop()` em todo caminho de saída.
 * Ainda assim o timer é AUTO-LIMITADO: a renovação exige status gravável e
 * lease viva, então um `stop()` esquecido morre sozinho na primeira batida
 * depois de o turno virar terminal. Um vazamento vira, no pior caso, uma
 * consulta a cada `TURN_LEASE_HEARTBEAT_MS` até o turno acabar — nunca um timer
 * imortal.
 */
export class TurnLease {
  readonly claim: TurnClaim;
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #failures = 0;
  #lost: LeaseLossReason | null = null;
  #leaseExpiresAt: Date;

  constructor(claim: TurnClaim, opts: { ttl_ms: number; heartbeat_ms: number }) {
    // Defesa em profundidade: a regra cross-field já barra isto no boot, mas um
    // caller programático (teste, script) pode montar valores próprios. Uma
    // lease mal dimensionada não é um bug local — é execução dupla.
    assertLeaseTiming(opts.ttl_ms, opts.heartbeat_ms);
    this.claim = claim;
    this.#leaseExpiresAt = claim.lease_expires_at;
    this.#timer = setInterval(() => void this.#beat(opts.ttl_ms), opts.heartbeat_ms);
    // Um heartbeat NUNCA deve segurar o event loop aberto: se o processo não
    // tem mais nada a fazer, ele deve poder terminar, e a lease vence sozinha.
    this.#timer.unref?.();
  }

  /** Sinal de cancelamento da tentativa. Abortado quando a posse é perdida. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Ainda somos o dono, até onde este processo sabe. */
  get alive(): boolean {
    return this.#lost === null;
  }

  /** Por que a posse foi perdida, ou `null` enquanto viva. */
  get lostReason(): LeaseLossReason | null {
    return this.#lost;
  }

  /**
   * O token do fence — mas SÓ enquanto a posse é nossa.
   *
   * Devolver `null` depois da perda é o que impede o padrão mais fácil de
   * errar: um caller que guardou `lease.token` no início e o usa no fim
   * escreveria com um token que ele mesmo já sabe inválido. Aqui o fence do
   * banco recusaria de qualquer forma; devolver `null` faz o caller falhar
   * antes, e falhar de um jeito legível.
   */
  get token(): string | null {
    return this.alive ? this.claim.claim_token : null;
  }

  /** Contexto de execução propagável (issue §Fencing). */
  context(deadline?: Date): TurnExecutionContext {
    return {
      tenant_id: this.claim.tenant_id,
      agent_id: this.claim.agent_id,
      turn_id: this.claim.turn_id,
      attempt: this.claim.attempt,
      claim_token: this.claim.claim_token,
      worker_id: this.claim.worker_id,
      // Sem deadline do caller, o horizonte é o vencimento da lease: para além
      // dele não temos autoridade para escrever, então prometer trabalho é
      // mentira. O orçamento GLOBAL do turno é #507 e entra por aqui.
      deadline: deadline ?? this.#leaseExpiresAt,
      signal: this.signal,
    };
  }

  /** Uma batida do heartbeat. Nunca lança — o timer não tem quem o pegue. */
  async #beat(ttl_ms: number): Promise<void> {
    if (!this.alive) return;
    try {
      const renewed = await agentTurnsRepo.renewTurnLease({
        turn_id: this.claim.turn_id,
        claim_token: this.claim.claim_token,
        lease_ms: ttl_ms,
      });
      if (!renewed.ok) {
        // Perdemos a posse. Ou outro worker assumiu depois de a lease vencer,
        // ou o turno já é terminal. Nos dois casos parar é a única reação
        // correta: continuar significaria escrever por cima de quem tem a posse.
        this.#lose('token_mismatch');
        return;
      }
      this.#failures = 0;
      this.#leaseExpiresAt = renewed.lease_expires_at;
      return;
    } catch (err) {
      // O banco não respondeu. Isto NÃO é perda de posse ainda — pode ser um
      // blip — mas o relógio da lease continua correndo do outro lado.
      this.#failures += 1;
      logger.warn(
        {
          turn_id: this.claim.turn_id,
          attempt: this.claim.attempt,
          worker_id: this.claim.worker_id,
          failures: this.#failures,
          err: (err as Error).message,
        },
        'turn.lease_heartbeat_failed',
      );
      incCounter('maia_turn_lease_heartbeat_total', { result: 'error' });
      if (this.#failures >= MAX_HEARTBEAT_FAILURES) {
        // Desistimos ANTES do vencimento (a aritmética de `MAX_HEARTBEAT_FAILURES`
        // garante a folga). Abortar cedo é o que impede a pior sequência da
        // issue: o worker segue processando, a lease vence, outro assume, e os
        // dois escrevem. Perder a tentativa é barato; escrever sem posse não é.
        this.#lose('heartbeat_failed');
      }
    }
  }

  /** Marca a perda, cancela a tentativa local e registra a anomalia. */
  #lose(reason: LeaseLossReason): void {
    if (this.#lost !== null) return;
    this.#lost = reason;
    this.#clearTimer();
    this.#abort.abort(new Error(`turn.lease_lost:${reason}`));
    if (reason === 'released') return; // liberação intencional não é anomalia
    incCounter('maia_turn_lease_lost_total', { reason });
    logger.error(
      {
        turn_id: this.claim.turn_id,
        attempt: this.claim.attempt,
        worker_id: this.claim.worker_id,
        reason,
        ops_alert: true,
      },
      'turn.lease_lost',
    );
    void audit({
      acao: 'turn_lease_lost',
      alvo_id: this.claim.turn_id,
      metadata: {
        reason,
        attempt: this.claim.attempt,
        worker_id: this.claim.worker_id,
      },
    }).catch((err) =>
      logger.warn({ err: (err as Error).message }, 'turn.lease_lost_audit_failed'),
    );
  }

  #clearTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Declara a posse PERDIDA a partir de evidência externa ao heartbeat.
   *
   * O caminho que a usa é o do FENCE: quando uma gravação da tentativa volta
   * `stale_claim`, o banco já respondeu a pergunta que o heartbeat faria no
   * próximo tick — não somos mais donos. Esperar a batida seguinte deixaria o
   * `AbortSignal` sem disparar por até um intervalo inteiro, e é justamente
   * nessa janela que o pipeline local continuaria trabalhando (chamando LLM,
   * executando tool) em nome de uma posse que já acabou.
   *
   * Idempotente: chamar duas vezes não duplica métrica nem auditoria.
   */
  markLost(reason: LeaseLossReason): void {
    this.#lose(reason);
  }

  /**
   * Para o heartbeat SEM devolver a posse.
   *
   * É o caminho de conclusão normal: a transição terminal já limpou
   * `claim_token`/`lease_expires_at` na mesma transação do CAS, então não há
   * nada a liberar — só um timer a desligar.
   */
  stop(): void {
    this.#clearTimer();
  }

  /**
   * DEVOLVE a posse explicitamente (shutdown gracioso, tentativa abortada).
   *
   * Vence a lease no banco para que um sucessor reivindique no próximo tick, em
   * vez de esperar o TTL inteiro. Depois disto este processo perde o direito de
   * escrever — inclusive porque `token` passa a devolver `null`.
   *
   * Nunca lança: é chamado de caminhos de encerramento, onde uma exceção
   * mascararia a causa real do encerramento.
   */
  async release(): Promise<void> {
    this.#clearTimer();
    if (!this.alive) return;
    try {
      await agentTurnsRepo.releaseTurnClaim({
        turn_id: this.claim.turn_id,
        claim_token: this.claim.claim_token,
      });
    } catch (err) {
      // Falhou em liberar: a lease vence sozinha em <= TTL. Perdemos velocidade
      // de recuperação, não correção.
      logger.warn(
        { turn_id: this.claim.turn_id, err: (err as Error).message },
        'turn.lease_release_failed',
      );
    } finally {
      this.#lose('released');
    }
  }
}

/**
 * Tenta tomar a posse do turno. `null` significa "não é meu" — e "não é meu"
 * NUNCA é motivo para processar assim mesmo.
 *
 * Devolve `{ lease: null, reason }` em vez de lançar porque perder a corrida é
 * o caminho NORMAL quando duas réplicas acordam com o mesmo job: transformar
 * isso em exceção encheria a DLQ de eventos saudáveis.
 */
export async function acquireTurnLease(turn_id: string): Promise<
  { lease: TurnLease; result: ClaimResult } | { lease: null; result: ClaimResult }
> {
  const ttl_ms = config.TURN_LEASE_TTL_MS;
  const heartbeat_ms = config.TURN_LEASE_HEARTBEAT_MS;
  const worker_id = turnWorkerId();
  const started = Date.now();
  const result = await agentTurnsRepo.claimNextEligibleTurn({
    turn_id,
    worker_id,
    lease_ms: ttl_ms,
  });
  // Sem `turn_id` como label (cardinalidade): o que interessa é a distribuição,
  // e um label por turno derrubaria o Prometheus antes de dizer qualquer coisa.
  observeHistogram('maia_turn_claim_latency_ms', Date.now() - started, {
    result: result.ok ? 'acquired' : result.reason,
  });
  await reportStreamClaimsRecovered(turn_id, result.recovered_stream_claims);
  if (!result.ok) {
    if (result.reason === 'stream_busy') await reportStreamBusy(turn_id, worker_id);
    // #626 — as duas recusas por POSIÇÃO na fila. Auditadas como uma só ação
    // (`turn_stream_blocked`) com o motivo no metadata: são o mesmo fato
    // operacional ("a conversa não avançou e o claim foi recusado") visto de
    // dois lugares, e separá-las em duas ações obrigaria todo consumidor de
    // auditoria a conhecer as duas para responder uma pergunta só.
    if (result.reason === 'not_head' || result.reason === 'stream_blocked') {
      await reportStreamHeadBlocked(turn_id, worker_id, result.reason, result.head_block);
    }
    logger.debug({ turn_id, worker_id, reason: result.reason }, 'turn.claim_not_acquired');
    return { lease: null, result };
  }
  if (result.fifo_violation) {
    await reportStreamFifoViolation(turn_id, result.fifo_violation);
  }
  logger.info(
    {
      turn_id,
      worker_id,
      attempt: result.claim.attempt,
      lease_expires_at: result.claim.lease_expires_at.toISOString(),
    },
    'turn.claimed',
  );
  return { lease: new TurnLease(result.claim, { ttl_ms, heartbeat_ms }), result };
}

/**
 * #625 — a stream estava OCUPADA: o banco recusou um segundo turno ativo.
 *
 * Vira `audit_log` e não só métrica porque é a única evidência durável de que a
 * exclusão por stream AGIU. A issue-mãe pede `stream.blocked` na auditoria
 * mínima, e sem a row não há como responder, depois do incidente, "esta
 * conversa parou porque o índice barrou, ou porque ninguém a reivindicou?" —
 * duas causas com remediações opostas.
 *
 * NÃO carrega `stream_key`: ela é um hash, mas o `turn_id` já ancora a
 * investigação, e a issue-mãe restringe `stream_key` a log estruturado e
 * armazenamento protegido. Como LABEL de métrica ela não aparece em lugar
 * nenhum — `maia_turn_claim_total{result="stream_busy"}` é agregada.
 *
 * VOLUME, e o que vigiar: uma row por claim RECUSADO, não por mensagem. Sem
 * head-of-line (#626) o job de um turno não-elegível ainda acorda, é recusado e
 * termina — então o custo é proporcional ao backlog de conversas QUENTES, não
 * ao tráfego. Se `maia_turn_claim_total{result="stream_busy"}` subir de forma
 * sustentada, o problema a resolver é a serialização, não o volume de audit; a
 * decisão de amostrar esta row pertence ao dono, e o runbook (§10.3) diz onde
 * ela apareceria primeiro.
 */
async function reportStreamBusy(turn_id: string, worker_id: string): Promise<void> {
  logger.info({ turn_id, worker_id }, 'turn.stream_busy');
  await audit({
    acao: 'turn_stream_busy',
    alvo_id: turn_id,
    metadata: { worker_id, reason: 'stream_busy' },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'turn.stream_busy_audit_failed'));
}

/**
 * #626 — o claim foi recusado porque a CONVERSA tem fila.
 *
 * Vira `audit_log` (`turn_stream_blocked`, a ação `stream.blocked` que a
 * issue-mãe pede na auditoria mínima) e `maia_stream_blocked_total{reason}`.
 * A métrica agrega; a row responde "esta conversa parou por quê, e atrás de
 * quem?" depois do incidente — sem ela, `not_head` em massa e uma stream morta
 * são indistinguíveis.
 *
 * `head_block.turn_id` entra no metadata e NUNCA como label de métrica
 * (cardinalidade). `stream_key` não entra em lugar nenhum: a issue-mãe a
 * restringe a log estruturado protegido, e o par (turno recusado, turno
 * bloqueador) já ancora a investigação.
 *
 * VOLUME: uma row por claim RECUSADO. Com o head-of-line ligado, um turno
 * posterior deixa de ser rearmado pelo recovery (a mesma regra filtra os
 * candidatos), então o custo é proporcional a quantas vezes o job de um turno
 * posterior ainda acorda — o backlog de conversas quentes, não o tráfego.
 */
async function reportStreamHeadBlocked(
  turn_id: string,
  worker_id: string,
  reason: StreamBlockedReason,
  head_block: { turn_id: string; status: string } | undefined,
): Promise<void> {
  logger.info(
    { turn_id, worker_id, reason, blocked_by: head_block?.turn_id ?? null },
    'turn.stream_head_blocked',
  );
  await audit({
    acao: 'turn_stream_blocked',
    alvo_id: turn_id,
    metadata: {
      worker_id,
      reason,
      ...(head_block
        ? { blocked_by_turn_id: head_block.turn_id, blocked_by_status: head_block.status }
        : {}),
    },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'turn.stream_head_blocked_audit_failed'),
  );
}

/**
 * #626 — o CANÁRIO disparou. Isto não deveria acontecer NUNCA.
 *
 * `maia_stream_fifo_violation_total` é, pela issue-mãe, um critério de ABORTAR
 * o rollout — está na mesma lista de "violação de isolamento". Por isso aqui é
 * `logger.error` com `ops_alert` e uma `audit_log` própria: uma inversão de
 * ordem que só existisse como incremento de contador seria impossível de
 * investigar depois, porque o contador não diz QUAL turno furou a fila nem
 * quantos estavam na frente.
 *
 * O claim NÃO é desfeito. A tentativa já está autorizada e revogá-la deixaria a
 * stream sem ninguém — trocaríamos uma inversão de ordem por uma parada. A
 * decisão de parar a coorte é do operador, com este sinal na mão.
 */
export async function reportStreamFifoViolation(
  turn_id: string,
  violation: { stage: StreamFifoViolationStage; earlier_live: number },
): Promise<void> {
  // A métrica do estágio `claim` já foi contada no repositório, dentro da
  // transação — contá-la de novo aqui dobraria o número. A do estágio
  // `recovery` é contada AQUI porque quem detecta é o varredor, que não tem
  // transação de claim nenhuma. Uma linha, duas origens: é a única forma de o
  // contador significar "violações", e não "relatos de violação".
  if (violation.stage === 'recovery') recordStreamFifoViolation('recovery');
  logger.error(
    {
      turn_id,
      stage: violation.stage,
      earlier_live: violation.earlier_live,
      ops_alert: true,
    },
    'turn.stream_fifo_violation',
  );
  await audit({
    acao: 'turn_stream_fifo_violation',
    alvo_id: turn_id,
    metadata: { stage: violation.stage, earlier_live: violation.earlier_live },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'turn.stream_fifo_violation_audit_failed'),
  );
}

/**
 * #625 — claims EXPIRADOS da stream foram recuperados dentro da transação do
 * claim, devolvendo turnos de donos mortos a `retryable`.
 *
 * É a metade TEMPORAL da exclusão por stream, e ela precisa de trilha própria
 * por uma razão operacional concreta: sem ela, um turno reaparece em
 * `retryable` sem que nada diga QUEM o rearmou. O varredor de recovery
 * (`src/workers/message-recovery.ts`) e este caminho produzem o mesmo estado
 * final, e distinguir "o sweeper achou" de "o claim da stream destravou" é o
 * que separa um deploy normal de uma stream que estava presa.
 *
 * `turn_id` aqui é o turno que ESTAVA reivindicando, não o recuperado — os
 * recuperados vão em `metadata.recovered`, que é o conjunto.
 */
async function reportStreamClaimsRecovered(
  turn_id: string,
  recovered: readonly StreamClaimRecovery[] | undefined,
): Promise<void> {
  if (!recovered || recovered.length === 0) return;
  const ids = recovered.map((r) => r.turn_id);
  logger.warn(
    { turn_id, recovered_turn_ids: ids, count: ids.length, ops_alert: true },
    'turn.stream_claims_recovered',
  );
  await audit({
    acao: 'turn_stream_claim_recovered',
    alvo_id: turn_id,
    metadata: { recovered: ids, count: ids.length },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'turn.stream_claims_recovered_audit_failed'),
  );

  // ─── #627 (fatia D) — A JANELA DE LATÊNCIA DA FATIA C, FECHADA ──────────
  //
  // O turno recuperado voltou a `retryable` com `next_attempt_at = now()`: ele
  // é reivindicável AGORA, e é o head da stream (quem tentou reivindicar está
  // atrás dele — senão não haveria claim expirado a recuperar). O que ele NÃO
  // tem é wake-up: o único job que existia era o do worker que morreu.
  //
  // Antes desta fatia, o desfecho documentado no runbook §11.5 era: a stream
  // destrava, o sucessor é recusado com `not_head`, e quem avança é o head — na
  // vez dele, quando o varredor o rearmar, o que leva até `STUCK_AFTER_MS`
  // (2 min). Ordem comprada com latência. Aqui a dívida é paga na hora.
  //
  // Roda DEPOIS de a transação do claim ter comitado (o `await` do repositório
  // já retornou), então a regra da issue vale igual: a decisão está no banco
  // (`promoted_at`, carimbado por `recoverExpiredStreamClaims`) antes de
  // qualquer sinal. Se este processo morrer aqui, o varredor reconcilia.
  for (const promocao of recovered) {
    await signalStreamPromotion(promocao, { source: 'stream_claim_recovery' });
  }
}

/**
 * Registra que uma gravação foi recusada pelo FENCE.
 *
 * Centralizado aqui (e não em cada caller) porque a issue exige métrica + log
 * + auditoria para TODA rejeição, e três caminhos independentes fazendo isso à
 * mão é como um deles acaba sem auditoria.
 */
export async function reportFenceRejection(args: {
  turn_id: string;
  operation: string;
  attempt: number;
  worker_id?: string;
  current_status?: string;
}): Promise<void> {
  incCounter('maia_turn_fence_rejected_total', { operation: args.operation });
  logger.error(
    {
      turn_id: args.turn_id,
      operation: args.operation,
      attempt: args.attempt,
      worker_id: args.worker_id ?? turnWorkerId(),
      current_status: args.current_status ?? null,
      ops_alert: true,
    },
    'turn.fence_rejected',
  );
  await audit({
    acao: 'turn_fence_rejected',
    alvo_id: args.turn_id,
    metadata: {
      operation: args.operation,
      attempt: args.attempt,
      worker_id: args.worker_id ?? turnWorkerId(),
      ...(args.current_status ? { current_status: args.current_status } : {}),
    },
  }).catch((err) =>
    logger.warn({ err: (err as Error).message }, 'turn.fence_rejected_audit_failed'),
  );
}
