/**
 * Issue #503 — repositório ÚNICO de escrita da máquina de estados do turno.
 *
 * Regras que este módulo existe para tornar impossíveis de violar:
 *
 *  1. Nenhum caller atualiza `agent_turns.status` diretamente. Toda transição
 *     entra por um método daqui, que valida o par (from, to, outcome) contra
 *     `src/runtime/turns/contract.ts` ANTES de tocar o banco.
 *  2. Toda transição é COMPARE-AND-SWAP: o UPDATE exige `status = ANY(origens
 *     válidas)` e, quando fornecida, `state_version = <esperada>`. Zero rows
 *     atualizadas NUNCA é sucesso silencioso — vira `{ ok: false, conflict }`
 *     tipado, com métrica.
 *  3. Todo WHERE carrega `tenant_id + agent_id` (do ALS). Nenhuma transição
 *     pode mover um turno entre tenants/agentes.
 *  4. Toda transição para estado TERMINAL escreve também a projeção legada
 *     `mensagens.processada_em` das mensagens do turno, na MESMA transação
 *     (compatibilidade de rollout — issue #503 §6). Estado não-terminal nunca
 *     escreve a projeção.
 *
 * Auditoria NÃO acontece aqui (o repositório é puro-DB, como os demais). Ela é
 * responsabilidade de `src/runtime/turns/lifecycle.ts`, o único chamador de
 * produção — manter `audit()` fora daqui também evita o ciclo de import
 * governance/audit -> repositories -> turn-repos.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { agent_turns, agent_turn_inputs, mensagens } from '../schema.js';
import type { AgentTurn, AgentTurnInput, Mensagem } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import { incCounter } from '@/lib/metrics.js';
import {
  assertTurnTransition,
  isTerminalTurnStatus,
  sourceStatusesFor,
  TERMINAL_TURN_STATUSES,
  RECOVERABLE_TURN_STATUSES,
  type TurnOutcome,
  type TurnRecoveryReason,
  type TurnStatus,
} from '@/runtime/turns/contract.js';
import type { ClaimRejection } from '@/runtime/turns/claim.js';

/** Resultado tipado de uma transição CAS. Conflito NUNCA é sucesso silencioso. */
export type TurnTransitionResult =
  | { ok: true; turn: AgentTurn; from: TurnStatus; to: TurnStatus }
  | { ok: false; conflict: 'not_found'; to: TurnStatus }
  | {
      ok: false;
      conflict: 'state_mismatch';
      to: TurnStatus;
      current_status: TurnStatus;
      current_state_version: number;
    }
  /**
   * FENCING (#504): a row existe e o estado até casaria, mas o `claim_token`
   * desta tentativa não é mais o vigente — outro worker assumiu o turno. É
   * DISTINTO de `state_mismatch` de propósito: um é corrida de estado
   * (recuperável, comum), o outro é um zumbi tentando gravar (nunca
   * recuperável, sempre auditável).
   */
  | {
      ok: false;
      conflict: 'stale_claim';
      to: TurnStatus;
      current_status: TurnStatus;
      current_claim_token: string | null;
      current_claimed_by: string | null;
    };

/** Candidato de recovery: o turno + o motivo pelo qual foi eleito. */
export type RecoverableTurn = { turn: AgentTurn; reason: TurnRecoveryReason };

/**
 * A posse conquistada por uma tentativa (#504). Tudo aqui vem do RETURNING do
 * claim, não de uma releitura — releitura reabriria a janela que o statement
 * único fechou.
 */
export type TurnClaim = {
  turn: AgentTurn;
  turn_id: string;
  tenant_id: string;
  agent_id: string;
  /** Fence desta tentativa. Toda escrita subsequente o carrega. */
  claim_token: string;
  /** Identidade do dono — `<hostname>:<pid>`, ver runtime/instance-identity.ts. */
  claimed_by: string;
  lease_expires_at: Date;
  /** Tentativa CANÔNICA (PostgreSQL), nunca `job.attemptsMade`. */
  attempt: number;
};

/** Resultado do claim. "Não adquiri" é resultado normal, não erro. */
export type TurnClaimResult =
  | { ok: true; claim: TurnClaim }
  | {
      ok: false;
      reason: ClaimRejection;
      current_status?: TurnStatus;
      current_claimed_by?: string | null;
      current_lease_expires_at?: Date | null;
    };

/** Resultado do heartbeat. `lost` é terminal para a tentativa local. */
export type TurnLeaseRenewal =
  | { ok: true; lease_expires_at: Date }
  | { ok: false; reason: 'lost' };

/** Campos operacionais que uma transição pode carregar junto do estado. */
export type TurnTransitionPatch = {
  conversa_id?: string | null;
  channel_id?: string | null;
  next_attempt_at?: Date | null;
  last_error_code?: string | null;
  last_error_summary?: string | null;
  outbound_message_id?: string | null;
  deadline_at?: Date | null;
  /** Turno que absorveu este pelo debounce (só faz sentido em `superseded`). */
  superseded_by_turn_id?: string | null;
  /** Incrementa `attempt_count` no mesmo UPDATE (retry). */
  bumpAttempt?: boolean;
  /**
   * Devolve a posse no MESMO UPDATE da transição (#504).
   *
   * Liberar a lease e mudar o estado são a MESMA decisão; separá-las em dois
   * statements é o bug que a #518 pagou para aprender (`completeCommand`): entre
   * o commit do estado e o da liberação existe uma janela em que o turno já
   * está `completed` mas ainda parece possuído — e um sweep que rodasse ali
   * tomaria posse de um turno terminal.
   */
  releaseClaim?: boolean;
};

type Executor = typeof db;

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

/** Colunas de timestamp carimbadas automaticamente ao entrar em cada estado. */
const STATE_TIMESTAMP: Partial<Record<TurnStatus, keyof AgentTurn>> = {
  queued: 'queued_at',
  claimed: 'claimed_at',
  running: 'started_at',
  outbound_pending: 'outbound_committed_at',
  completed: 'completed_at',
  ignored: 'completed_at',
  superseded: 'completed_at',
  dead_letter: 'dead_lettered_at',
};

function transitionLabel(from: TurnStatus | 'any', to: TurnStatus): string {
  return `${from}->${to}`;
}

export const agentTurnsRepo = {
  /**
   * Ingresso ATÔMICO: persiste a mensagem inbound, cria o turno em `received` e
   * associa a mensagem como input 0 — tudo numa única transação PostgreSQL.
   *
   * O commit atômico entre PostgreSQL e Redis é impossível; o contrato da issue
   * resolve assim: o Postgres grava `received`, o caller tenta o enqueue e só
   * então chama `markQueued`. Se o processo morrer em qualquer janela, o
   * recovery reencontra o turno em `received` (o jobId determinístico de #504
   * garante que rearmar não duplica execução).
   *
   * Se a mensagem já tiver turno (retry de ingresso), o ON CONFLICT devolve o
   * turno existente — a operação é idempotente por `representative_message_id`.
   */
  async createReceivedTurnTx(input: {
    mensagem: Record<string, unknown>;
    channel_id?: string | null;
    deadline_at?: Date | null;
  }): Promise<{ mensagem: Mensagem; turn: AgentTurn }> {
    const guardedMensagem = applyTenantGuard({
      ...input.mensagem,
      channel_id: input.channel_id ?? (input.mensagem['channel_id'] as string | null) ?? null,
    });
    return withTx(async (tx) => {
      const inserted = await tx
        .insert(mensagens)
        .values(guardedMensagem as never)
        .returning();
      const row = inserted[0]!;
      const turn = await createTurnForMessage(tx, {
        mensagem: row,
        deadline_at: input.deadline_at ?? null,
      });
      incCounter('maia_turn_transitions_total', { from: 'none', to: 'received', outcome: 'none' });
      return { mensagem: row, turn };
    });
  },

  /**
   * Cria o turno `received` para uma mensagem JÁ persistida.
   *
   * Usado (a) pelo backfill e (b) como rede de compatibilidade para caminhos de
   * ingresso que persistiram a mensagem antes desta issue (deploy rolling, row
   * recuperada pelo sweep). Idempotente: se a mensagem já pertence a um turno,
   * devolve o turno existente sem criar outro.
   */
  async ensureTurnForMessage(
    mensagem: Pick<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'conversa_id' | 'channel_id'>,
    opts: { deadline_at?: Date | null } = {},
  ): Promise<AgentTurn> {
    return withTx((tx) =>
      createTurnForMessage(tx, { mensagem, deadline_at: opts.deadline_at ?? null }),
    );
  },

  /**
   * Associa uma mensagem adicional (irmã do debounce) ao turno.
   *
   * Idempotente e FAIL-CLOSED quanto à unicidade: se a mensagem já pertence a
   * OUTRO turno, o ON CONFLICT não faz nada e devolve `already_attached` — a
   * invariante "uma mensagem inbound pertence a no máximo um turno" é do banco
   * (unique em `agent_turn_inputs.mensagem_id`), não da aplicação.
   */
  async attachInputTx(input: {
    turn_id: string;
    mensagem_id: string;
    ingress_seq: number;
  }): Promise<{ attached: boolean; reason?: 'already_attached' }> {
    const guarded = applyTenantGuard({
      turn_id: input.turn_id,
      mensagem_id: input.mensagem_id,
      ingress_seq: input.ingress_seq,
    });
    const rows = await db
      .insert(agent_turn_inputs)
      .values(guarded)
      .onConflictDoNothing()
      .returning({ id: agent_turn_inputs.id });
    return rows.length === 1 ? { attached: true } : { attached: false, reason: 'already_attached' };
  },

  /**
   * Transição genérica com compare-and-swap.
   *
   * FAIL-LOUD (throw `InvalidTurnTransitionError`) quando o par (from, to,
   * outcome) é proibido pelo contrato — isso é bug de programação. CONFLITO de
   * concorrência (0 rows) é resultado TIPADO.
   *
   * @param input.expected_statuses restringe as origens além do que o contrato
   *   já permite (ex.: só aceitar `running` para `outbound_pending`). Omitido =
   *   todas as origens que o contrato admite para `to`.
   * @param input.expected_version quando fornecida, o UPDATE também exige
   *   `state_version = expected_version` (CAS estrito, para leitura-modificação
   *   -escrita otimista).
   * @param input.expected_claim_token FENCING (#504): quando fornecido, o
   *   UPDATE também exige `claim_token = <token>`. Zero rows com a row presente
   *   e token divergente vira `conflict: 'stale_claim'` — nunca sucesso, nunca
   *   sobrescrita da posse alheia.
   */
  async transitionTurn(input: {
    turn_id: string;
    to: TurnStatus;
    outcome?: TurnOutcome | null;
    expected_statuses?: readonly TurnStatus[];
    expected_version?: number;
    expected_claim_token?: string;
    patch?: TurnTransitionPatch;
    manual?: boolean;
  }): Promise<TurnTransitionResult> {
    const outcome = input.outcome ?? null;
    const allowedSources = sourceStatusesFor(input.to, { manual: input.manual === true });
    const sources = input.expected_statuses
      ? input.expected_statuses.filter((s) => allowedSources.includes(s))
      : allowedSources;

    // Valida cada origem admitida — qualquer par proibido é erro de programação.
    for (const from of sources) {
      assertTurnTransition(from, input.to, outcome, { manual: input.manual === true });
    }
    if (sources.length === 0) {
      // `expected_statuses` não intersecta o contrato: também é bug, e falhar
      // fechado aqui evita um UPDATE que jamais casaria (0 rows lidas como
      // "conflito", mascarando o defeito).
      assertTurnTransition(
        (input.expected_statuses?.[0] ?? input.to) as TurnStatus,
        input.to,
        outcome,
        { manual: input.manual === true },
      );
    }

    // Toda saída de uma tentativa devolve a posse no MESMO UPDATE: estados
    // TERMINAIS (o trabalho acabou) e `retryable` (a tentativa acabou, a
    // próxima reivindica de novo). `claimed`/`running`/`outbound_pending`
    // mantêm a lease — a tentativa continua viva.
    const releasesClaim =
      isTerminalTurnStatus(input.to) || input.to === 'retryable' || input.to === 'queued';

    return runTransition({
      turn_id: input.turn_id,
      to: input.to,
      outcome,
      sources,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: { releaseClaim: releasesClaim, ...(input.patch ?? {}) },
    });
  },

  /** `received | retryable -> queued` (wake-up do BullMQ confirmado). */
  async markQueued(input: {
    turn_id: string;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'queued',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { next_attempt_at: null },
    });
  },

  /**
   * `received | queued -> claimed`. Nesta issue o claim é apenas de ESTADO — o
   * claim atômico com lease/fencing/`claim_token` chega em #504, que substitui
   * esta implementação preservando a assinatura.
   */
  async markClaimed(input: {
    turn_id: string;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'claimed',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
    });
  },

  /**
   * `claimed -> running` (execução efetivamente iniciada).
   *
   * `bump_attempt` existe por causa de #504: quando o claim atômico está no
   * caminho, é ELE quem incrementa `attempt_count` (num único statement, junto
   * com o token e a lease), e contar de novo aqui inflaria a tentativa canônica
   * — o número que decide retry vs. dead letter. No caminho sem claim (rollout
   * com `FEATURE_TURN_CLAIM=false`) o incremento continua aqui.
   */
  async markRunning(input: {
    turn_id: string;
    conversa_id?: string | null;
    channel_id?: string | null;
    expected_version?: number;
    expected_claim_token?: string;
    bump_attempt?: boolean;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'running',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: {
        bumpAttempt: input.bump_attempt ?? true,
        ...(input.conversa_id !== undefined ? { conversa_id: input.conversa_id } : {}),
        ...(input.channel_id !== undefined ? { channel_id: input.channel_id } : {}),
      },
    });
  },

  /**
   * `running -> outbound_pending`. A partir daqui o ReAct e as tools NÃO podem
   * ser reexecutados: a resposta está comprometida e só o delivery worker
   * finaliza (#506). Por isso `expected_statuses` é fixo em `running` e a
   * tabela de transições não tem aresta de volta.
   */
  async markOutboundCommittedTx(input: {
    turn_id: string;
    outbound_message_id: string;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'outbound_pending',
      expected_statuses: ['running'],
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: { outbound_message_id: input.outbound_message_id },
    });
  },

  /** `running | outbound_pending -> completed` com outcome de conclusão. */
  async completeTurnTx(input: {
    turn_id: string;
    outcome: TurnOutcome;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'completed',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: { next_attempt_at: null },
    });
  },

  /** Descarte intencional por regra explícita (`received | running -> ignored`). */
  async markIgnored(input: {
    turn_id: string;
    outcome: TurnOutcome;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'ignored',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: { next_attempt_at: null },
    });
  },

  /** Turno incorporado a outro pelo debounce (`received | queued -> superseded`). */
  async markSuperseded(input: {
    turn_id: string;
    /** Turno EXECUTOR que absorveu este. Persistido em `superseded_by_turn_id`. */
    absorbed_by_turn_id?: string;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'superseded',
      outcome: 'merged_into_turn',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: {
        next_attempt_at: null,
        ...(input.absorbed_by_turn_id !== undefined
          ? { superseded_by_turn_id: input.absorbed_by_turn_id }
          : {}),
      },
    });
  },

  /** Turnos que foram absorvidos por `turn_id` (rajada de debounce). */
  async listAbsorbedTurns(turn_id: string): Promise<AgentTurn[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .select()
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.superseded_by_turn_id, turn_id),
        ),
      )
      .orderBy(asc(agent_turns.created_at));
  },

  /**
   * Falha ANTES de efeito irreversível — a tentativa pode ser refeita.
   * NÃO é terminal: nenhuma projeção `processada_em` é escrita, e o recovery
   * rearma quando `next_attempt_at` vence.
   */
  async markRetryable(input: {
    turn_id: string;
    next_attempt_at: Date;
    error_code: string;
    error_summary: string | null;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'retryable',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: {
        next_attempt_at: input.next_attempt_at,
        last_error_code: input.error_code,
        last_error_summary: input.error_summary,
      },
    });
  },

  /** Tentativas esgotadas ou estado que exige intervenção humana. TERMINAL. */
  async markDeadLetter(input: {
    turn_id: string;
    outcome: Extract<TurnOutcome, 'retry_exhausted' | 'operator_cancelled' | 'unsafe_to_retry'>;
    error_code: string;
    error_summary: string | null;
    expected_version?: number;
    expected_claim_token?: string;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'dead_letter',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      patch: {
        next_attempt_at: null,
        last_error_code: input.error_code,
        last_error_summary: input.error_summary,
      },
    });
  },

  /**
   * Replay MANUAL de dead letter — porta explícita e auditada (o chamador
   * DEVE auditar). Gera nova tentativa: `attempt_count` incrementa e o
   * `claim_token` anterior é descartado, de modo que um worker zumbi com o
   * token velho não consiga fechar o turno (fencing completo em #504).
   */
  async replayDeadLetterTx(input: {
    turn_id: string;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'queued',
      expected_statuses: ['dead_letter'],
      manual: true,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { bumpAttempt: true, next_attempt_at: null },
    });
  },

  // ─── Claim atômico, lease e fencing (issue #504) ─────────────────────────

  /**
   * CLAIM ATÔMICO: um único `UPDATE ... RETURNING` que decide o dono do turno.
   *
   * É a primitiva central desta issue. Vence quem o PostgreSQL disser que
   * venceu — não a fila, não o worker, não a ordem de chegada no Redis. Zero
   * rows significa "não adquiri", que NÃO é erro e NÃO autoriza processamento.
   *
   * ── Por que um statement só ────────────────────────────────────────────────
   * O padrão "SELECT elegível" seguido de "UPDATE" mantém a janela de corrida
   * inteira: dois workers leem a mesma row elegível e ambos atualizam, o
   * segundo por cima do primeiro. Aqui o predicado de elegibilidade e a escrita
   * de posse são a MESMA operação, e o PostgreSQL serializa a row: o segundo
   * worker reavalia o predicado sobre a versão já atualizada, não casa, e
   * recebe zero rows. Não há janela.
   *
   * ── Elegibilidade ──────────────────────────────────────────────────────────
   *   received | queued                — trabalho novo;
   *   retryable com backoff VENCIDO    — `next_attempt_at <= now()`;
   *   claimed | running com lease morta — TAKEOVER de worker que caiu;
   *   claimed | running SEM lease e     — órfão pré-#504 (ver bloco abaixo).
   *     parado há 3× TTL
   *
   * `outbound_pending` e os terminais estão FORA por construção.
   *
   * ── O ramo do órfão ────────────────────────────────────────────────────────
   * Antes desta issue, `markClaimed` movia o turno para `claimed` sem gravar
   * lease. Um worker que morresse ali deixava o turno preso PARA SEMPRE: o
   * recovery de #503 exige `lease_expires_at IS NOT NULL` justamente para não
   * rearmar às cegas. Pela invariante do trio (migration 108), uma row
   * `claimed`/`running` com lease NULL é, por definição, NÃO POSSUÍDA — nenhum
   * worker #504 pode estar segurando-a. O guard extra de `updated_at` (3× TTL)
   * cobre a única exceção: a janela de deploy rolling em que uma réplica ANTIGA
   * ainda pudesse estar executando esse turno sem lease.
   *
   * ── Relógio ────────────────────────────────────────────────────────────────
   * Todo `now()` é do PostgreSQL, nunca do processo. Clock skew entre réplicas
   * decidiria quem é dono, o que é inaceitável — a fonte de verdade do tempo é
   * a mesma fonte de verdade do estado.
   */
  async tryClaimTurn(input: {
    turn_id: string;
    worker_id: string;
    lease_ms: number;
  }): Promise<TurnClaimResult> {
    const { tenant_id, agent_id } = scope();
    const leaseMs = Math.max(1, Math.floor(input.lease_ms));
    const orphanMs = leaseMs * 3;

    const updated = await db
      .update(agent_turns)
      .set({
        status: 'claimed',
        attempt_count: sql`${agent_turns.attempt_count} + 1`,
        // Token IMPREVISÍVEL (uuid v4 do próprio banco). Imprevisibilidade
        // basta para fencing: o zumbi não pode adivinhar o token do sucessor,
        // e o CAS por igualdade não precisa de ordem.
        claim_token: sql`gen_random_uuid()`,
        claimed_by: input.worker_id,
        claimed_at: sql`now()`,
        heartbeat_at: sql`now()`,
        lease_expires_at: sql`now() + (${leaseMs}::text || ' milliseconds')::interval`,
        state_version: sql`${agent_turns.state_version} + 1`,
        next_attempt_at: null,
        updated_at: sql`now()`,
      } as never)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, input.turn_id),
          sql`(
            ${agent_turns.status} IN ('received', 'queued')
            OR (
              ${agent_turns.status} = 'retryable'
              AND (${agent_turns.next_attempt_at} IS NULL OR ${agent_turns.next_attempt_at} <= now())
            )
            OR (
              ${agent_turns.status} IN ('claimed', 'running')
              AND ${agent_turns.lease_expires_at} IS NOT NULL
              AND ${agent_turns.lease_expires_at} <= now()
            )
            OR (
              ${agent_turns.status} IN ('claimed', 'running')
              AND ${agent_turns.lease_expires_at} IS NULL
              AND ${agent_turns.updated_at} <= now() - (${orphanMs}::text || ' milliseconds')::interval
            )
          )`,
        ),
      )
      .returning();

    const turn = updated[0];
    if (turn) {
      incCounter('maia_turn_claim_total', { result: 'acquired' });
      return {
        ok: true as const,
        claim: {
          turn,
          turn_id: turn.id,
          tenant_id: turn.tenant_id,
          agent_id: turn.agent_id,
          claim_token: turn.claim_token!,
          claimed_by: turn.claimed_by!,
          lease_expires_at: turn.lease_expires_at!,
          attempt: turn.attempt_count,
        },
      };
    }

    // Não adquiriu. A releitura serve só para CLASSIFICAR o motivo — é
    // diagnóstico, não decisão: seja qual for a resposta, este worker não
    // processa. Sem ela, "outro worker está com a lease" e "o turno já acabou"
    // seriam o mesmo evento no painel, e são incidentes diferentes.
    const current = await db
      .select({
        status: agent_turns.status,
        lease_expires_at: agent_turns.lease_expires_at,
        claimed_by: agent_turns.claimed_by,
        next_attempt_at: agent_turns.next_attempt_at,
      })
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, input.turn_id),
        ),
      )
      .limit(1);
    const row = current[0];
    if (!row) {
      incCounter('maia_turn_claim_total', { result: 'not_found' });
      return { ok: false as const, reason: 'not_found' as const };
    }
    const status = row.status as TurnStatus;
    const reason: ClaimRejection =
      status === 'retryable'
        ? 'backoff_pending'
        : status === 'claimed' || status === 'running'
          ? 'lease_active'
          : 'not_claimable';
    incCounter('maia_turn_claim_total', { result: reason });
    return {
      ok: false as const,
      reason,
      current_status: status,
      current_claimed_by: row.claimed_by,
      current_lease_expires_at: row.lease_expires_at,
    };
  },

  /**
   * HEARTBEAT: renova a lease enquanto o dono está saudável.
   *
   * Três guardas no WHERE, cada uma fechando um cenário distinto:
   *   `claim_token = $token` — só o dono ATUAL renova. Um zumbi com token velho
   *      não pode empurrar a lease do sucessor para frente;
   *   `claimed_by = $worker` — a identidade também precisa bater; token igual
   *      com dono diferente é corrupção, não renovação;
   *   `lease_expires_at > now()` — uma lease JÁ VENCIDA não é renovável. É a
   *      regra da issue "um worker que recuperar conectividade após perder o
   *      lease não pode retomá-lo implicitamente": se venceu, o turno voltou ao
   *      pool, e ressuscitar a posse por baixo de um possível sucessor é
   *      exatamente a execução concorrente que o fencing existe para impedir.
   *
   * NÃO incrementa `state_version` de propósito: heartbeat não é transição de
   * estado, e bumpar invalidaria o CAS otimista que a tentativa carrega no
   * handle durante o turno inteiro.
   */
  async renewTurnLease(input: {
    turn_id: string;
    claim_token: string;
    worker_id: string;
    lease_ms: number;
  }): Promise<TurnLeaseRenewal> {
    const { tenant_id, agent_id } = scope();
    const leaseMs = Math.max(1, Math.floor(input.lease_ms));
    const rows = await db
      .update(agent_turns)
      .set({
        heartbeat_at: sql`now()`,
        lease_expires_at: sql`now() + (${leaseMs}::text || ' milliseconds')::interval`,
        updated_at: sql`now()`,
      } as never)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, input.turn_id),
          eq(agent_turns.claim_token, input.claim_token),
          eq(agent_turns.claimed_by, input.worker_id),
          inArray(agent_turns.status, ['claimed', 'running', 'outbound_pending']),
          sql`${agent_turns.lease_expires_at} > now()`,
        ),
      )
      .returning({
        lease_expires_at: agent_turns.lease_expires_at,
        status: agent_turns.status,
      });

    const row = rows[0];
    if (row?.lease_expires_at) {
      incCounter('maia_turn_lease_heartbeat_total', { result: 'renewed' });
      return { ok: true as const, lease_expires_at: row.lease_expires_at };
    }
    incCounter('maia_turn_lease_heartbeat_total', { result: 'lost' });
    return { ok: false as const, reason: 'lost' as const };
  },

  /**
   * Devolve a posse EXPLICITAMENTE (shutdown ordenado, aborto de tentativa).
   *
   * Só o dono corrente consegue — o CAS por `claim_token` impede que um zumbi
   * "libere" a lease do sucessor, que seria uma forma sofisticada de sabotar
   * quem está trabalhando. Liberar em vez de esperar o TTL faz o próximo
   * recovery reencontrar o turno em segundos, não em um TTL inteiro.
   *
   * NÃO muda `status`: quem decide se a tentativa vira `retryable` é a política
   * de ciclo de vida (`src/runtime/turns/lifecycle.ts`), que conhece a contagem
   * de tentativas e o backoff. O repositório só devolve a chave.
   */
  async releaseTurnLease(input: {
    turn_id: string;
    claim_token: string;
  }): Promise<{ released: boolean }> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .update(agent_turns)
      .set({
        claimed_by: null,
        claim_token: null,
        lease_expires_at: null,
        updated_at: sql`now()`,
      } as never)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, input.turn_id),
          eq(agent_turns.claim_token, input.claim_token),
        ),
      )
      .returning({ id: agent_turns.id });
    return { released: rows.length > 0 };
  },

  /**
   * Localiza o turno SEM contexto de tenant — padrão sancionado de ENTRY POINT,
   * o mesmo de `channelsRepo.findByExternalCrossTenant` e de
   * `channelLineStateRepo.claimNextCommand`.
   *
   * Necessário porque o job V2 carrega só o `turn_id`: o worker precisa
   * descobrir a qual (tenant, agent) o turno pertence ANTES de poder abrir o
   * `runWithTenantContext` sob o qual todo o resto roda. A própria row é a
   * autoridade — nada de tenant vem do payload, que é exatamente a regra
   * "nenhuma informação de tenant vinda apenas do payload pode ser confiada".
   *
   * Devolve o MÍNIMO: identidade e escopo. O turno completo é relido dentro do
   * contexto, pelo caminho escopado.
   */
  async findScopeByIdCrossTenant(turn_id: string): Promise<{
    turn_id: string;
    tenant_id: string;
    agent_id: string;
    representative_message_id: string;
    status: TurnStatus;
  } | null> {
    const rows = await db
      .select({
        turn_id: agent_turns.id,
        tenant_id: agent_turns.tenant_id,
        agent_id: agent_turns.agent_id,
        representative_message_id: agent_turns.representative_message_id,
        status: agent_turns.status,
      })
      .from(agent_turns)
      .where(eq(agent_turns.id, turn_id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // FAIL-CLOSED: uma row sem escopo não pode abrir contexto. Não deveria
    // existir (NOT NULL no schema), mas o custo da checagem é zero e o custo de
    // processar sem escopo é vazamento entre tenants.
    if (!row.tenant_id || !row.agent_id) return null;
    return { ...row, status: row.status as TurnStatus };
  },

  // ─── Leitura ─────────────────────────────────────────────────────────────

  async findById(turn_id: string): Promise<AgentTurn | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select()
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, turn_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** O turno que consumiu uma mensagem inbound (representativa ou agregada). */
  async findTurnByMessage(mensagem_id: string): Promise<AgentTurn | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select({ turn: agent_turns })
      .from(agent_turn_inputs)
      .innerJoin(
        agent_turns,
        and(
          eq(agent_turns.id, agent_turn_inputs.turn_id),
          eq(agent_turns.tenant_id, agent_turn_inputs.tenant_id),
          eq(agent_turns.agent_id, agent_turn_inputs.agent_id),
        ),
      )
      .where(
        and(
          eq(agent_turn_inputs.tenant_id, tenant_id),
          eq(agent_turn_inputs.agent_id, agent_id),
          eq(agent_turn_inputs.mensagem_id, mensagem_id),
        ),
      )
      .limit(1);
    return rows[0]?.turn ?? null;
  },

  async listTurnInputs(turn_id: string): Promise<AgentTurnInput[]> {
    const { tenant_id, agent_id } = scope();
    return db
      .select()
      .from(agent_turn_inputs)
      .where(
        and(
          eq(agent_turn_inputs.tenant_id, tenant_id),
          eq(agent_turn_inputs.agent_id, agent_id),
          eq(agent_turn_inputs.turn_id, turn_id),
        ),
      )
      .orderBy(asc(agent_turn_inputs.ingress_seq), asc(agent_turn_inputs.created_at));
  },

  /**
   * Candidatos de recovery, POR ESTADO — não por idade de timestamp solto.
   *
   * Elegíveis:
   *   - `received` mais antigo que `stale_ms` (enqueue nunca confirmado);
   *   - `queued` mais antigo que `stale_ms` (job perdido / worker morto);
   *   - `retryable` com `next_attempt_at <= now()`;
   *   - `claimed`/`running` com lease VENCIDA (`lease_expires_at <= now()`).
   *     Enquanto #504 não popula `lease_expires_at`, esse ramo simplesmente não
   *     casa — fail-closed: nunca rearmamos um turno em execução às cegas.
   *
   * NUNCA elegíveis: `outbound_pending`, `completed`, `ignored`, `superseded`,
   * `dead_letter`.
   */
  async findRecoverableTurns(stale_ms: number, limit = 200): Promise<RecoverableTurn[]> {
    const { tenant_id, agent_id } = scope();
    const cutoff = new Date(Date.now() - stale_ms);
    const rows = await db
      .select()
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          inArray(agent_turns.status, [...RECOVERABLE_TURN_STATUSES]),
          or(
            and(
              inArray(agent_turns.status, ['received', 'queued']),
              lte(agent_turns.created_at, cutoff),
            ),
            and(
              eq(agent_turns.status, 'retryable'),
              sql`${agent_turns.next_attempt_at} IS NOT NULL AND ${agent_turns.next_attempt_at} <= now()`,
            ),
            and(
              inArray(agent_turns.status, ['claimed', 'running']),
              sql`${agent_turns.lease_expires_at} IS NOT NULL AND ${agent_turns.lease_expires_at} <= now()`,
            ),
          ),
        ),
      )
      .orderBy(asc(agent_turns.created_at))
      .limit(limit);
    return rows.map((turn) => ({ turn, reason: recoveryReasonFor(turn) }));
  },

  /**
   * Enumeração CROSS-TENANT dos pares (tenant, agent) com turnos recuperáveis.
   * Roda FORA de contexto de tenant — é o dispatcher, como o de mensagens
   * (`listTenantAgentPairsWithUnprocessedOlderThan`, issue #345). O predicado
   * espelha EXATAMENTE `findRecoverableTurns`, para que um par só seja
   * enumerado quando o inner de fato teria trabalho.
   */
  async listTenantAgentPairsWithRecoverableTurns(
    stale_ms: number,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const cutoff = new Date(Date.now() - stale_ms);
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${agent_turns}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND (
          (status IN ('received', 'queued') AND created_at <= ${cutoff.toISOString()})
          OR (status = 'retryable' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
          OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
        )
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  /**
   * Verificador de DIVERGÊNCIA entre a máquina de estados e a projeção legada
   * (issue #503 §6, passo de shadow-read).
   *
   * Conta, no escopo corrente, as duas direções da inconsistência:
   *   - `terminal_without_projection`: turno terminal cuja mensagem ainda tem
   *     `processada_em IS NULL` (a projeção falhou);
   *   - `projection_without_terminal`: mensagem com `processada_em` preenchido
   *     cujo turno NÃO é terminal (o caminho legado concluiu por fora).
   *
   * Somente LEITURA: não corrige nada. O operador decide (ver runbook).
   */
  async countLegacyProjectionMismatch(): Promise<{
    terminal_without_projection: number;
    projection_without_terminal: number;
  }> {
    const { tenant_id, agent_id } = scope();
    const result = await db.execute<{ kind: string; total: string }>(sql`
      SELECT kind, count(*)::text AS total
      FROM (
        SELECT
          CASE
            WHEN t.status IN ('completed', 'ignored', 'superseded', 'dead_letter')
                 AND m.processada_em IS NULL THEN 'terminal_without_projection'
            WHEN t.status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter')
                 AND m.processada_em IS NOT NULL THEN 'projection_without_terminal'
            ELSE NULL
          END AS kind
        FROM ${agent_turn_inputs} i
        JOIN ${agent_turns} t
          ON t.id = i.turn_id AND t.tenant_id = i.tenant_id AND t.agent_id = i.agent_id
        JOIN ${mensagens} m
          ON m.id = i.mensagem_id AND m.tenant_id = i.tenant_id AND m.agent_id = i.agent_id
        WHERE i.tenant_id = ${tenant_id} AND i.agent_id = ${agent_id}
      ) s
      WHERE kind IS NOT NULL
      GROUP BY kind
    `);
    const out = { terminal_without_projection: 0, projection_without_terminal: 0 };
    for (const row of result.rows as unknown as Array<{ kind: string; total: string }>) {
      if (row.kind === 'terminal_without_projection') {
        out.terminal_without_projection = Number(row.total);
      } else if (row.kind === 'projection_without_terminal') {
        out.projection_without_terminal = Number(row.total);
      }
    }
    return out;
  },

  /**
   * Snapshot dos turnos VIVOS por estado, para os gauges de `/metrics`
   * (`maia_turns_current` e `maia_turn_state_age_seconds`).
   *
   * CROSS-TENANT e sem ALS por construção: o scrape do Prometheus não roda
   * dentro de contexto de tenant, e o sinal que interessa (turno preso,
   * envelhecimento por estado) é global à instalação. Nenhum dado por tenant é
   * exposto — só contagem e idade agregadas por estado.
   *
   * Só estados NÃO-terminais. Terminais crescem indefinidamente, são volume
   * histórico e não sinal de saúde; incluí-los trocaria um índice parcial por
   * um scan da tabela inteira a cada scrape. O índice
   * `agent_turns_live_status_idx` cobre exatamente este predicado.
   *
   * `oldest_age_seconds` usa `min(updated_at)`: é a idade do turno mais ANTIGO
   * naquele estado — a métrica que dispara alerta quando algo trava.
   */
  async snapshotLiveTurnStates(): Promise<
    Array<{ status: TurnStatus; total: number; oldest_age_seconds: number }>
  > {
    const result = await db.execute<{
      status: string;
      total: string;
      oldest_age_seconds: string;
    }>(sql`
      SELECT
        status,
        count(*)::text AS total,
        COALESCE(EXTRACT(EPOCH FROM (now() - min(updated_at))), 0)::text AS oldest_age_seconds
      FROM ${agent_turns}
      WHERE status IN ('received', 'queued', 'claimed', 'running', 'outbound_pending', 'retryable')
      GROUP BY status
    `);
    return Array.from(
      result.rows as unknown as Array<{
        status: string;
        total: string;
        oldest_age_seconds: string;
      }>,
    ).map((r) => ({
      status: r.status as TurnStatus,
      total: Number(r.total),
      oldest_age_seconds: Math.max(0, Math.round(Number(r.oldest_age_seconds))),
    }));
  },

  /**
   * Divergência POR PAR (tenant, agent), CROSS-TENANT e sem ALS.
   *
   * A variante escopada acima só enxerga o par corrente, e o worker a chamava
   * apenas para os pares que a fonte de recovery já havia enumerado — de modo
   * que a divergência CENTRAL da issue (um turno `retryable` com
   * `processada_em` preenchido) podia nunca virar métrica, justamente porque
   * aquele par não tinha trabalho pendente na fila. Este método varre a base
   * inteira, uma query só, e devolve apenas os pares COM divergência.
   *
   * Roda fora de contexto de tenant por construção (é um dispatcher, como as
   * demais enumerações); o escopo está no GROUP BY, não num WHERE de ALS.
   */
  async countLegacyProjectionMismatchByPair(): Promise<
    Array<{
      tenant_id: string;
      agent_id: string;
      terminal_without_projection: number;
      projection_without_terminal: number;
    }>
  > {
    const result = await db.execute<{
      tenant_id: string;
      agent_id: string;
      terminal_without_projection: string;
      projection_without_terminal: string;
    }>(sql`
      SELECT
        i.tenant_id,
        i.agent_id,
        count(*) FILTER (
          WHERE t.status IN ('completed', 'ignored', 'superseded', 'dead_letter')
            AND m.processada_em IS NULL
        )::text AS terminal_without_projection,
        count(*) FILTER (
          WHERE t.status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter')
            AND m.processada_em IS NOT NULL
        )::text AS projection_without_terminal
      FROM ${agent_turn_inputs} i
      JOIN ${agent_turns} t
        ON t.id = i.turn_id AND t.tenant_id = i.tenant_id AND t.agent_id = i.agent_id
      JOIN ${mensagens} m
        ON m.id = i.mensagem_id AND m.tenant_id = i.tenant_id AND m.agent_id = i.agent_id
      GROUP BY i.tenant_id, i.agent_id
      HAVING count(*) FILTER (
               WHERE t.status IN ('completed', 'ignored', 'superseded', 'dead_letter')
                 AND m.processada_em IS NULL
             ) > 0
          OR count(*) FILTER (
               WHERE t.status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter')
                 AND m.processada_em IS NOT NULL
             ) > 0
    `);
    return Array.from(
      result.rows as unknown as Array<{
        tenant_id: string;
        agent_id: string;
        terminal_without_projection: string;
        projection_without_terminal: string;
      }>,
    ).map((r) => ({
      tenant_id: r.tenant_id,
      agent_id: r.agent_id,
      terminal_without_projection: Number(r.terminal_without_projection),
      projection_without_terminal: Number(r.projection_without_terminal),
    }));
  },

  /**
   * Um lote do backfill (issue #503 §7). Cria um turno por mensagem inbound
   * histórica AINDA sem turno, mapeando a projeção legada:
   *   - `processada_em IS NOT NULL` -> `completed` / `legacy_processed`, com
   *     `completed_at = processada_em`;
   *   - `processada_em IS NULL`     -> `received`, `next_attempt_at = now()`.
   *
   * IDEMPOTENTE e RESUMÍVEL: o `NOT EXISTS` sobre `agent_turn_inputs` e a
   * unique em `representative_message_id` fazem uma segunda execução não criar
   * turno duplicado. Roda em LOTE (`limit`), numa transação curta por lote —
   * nunca uma transação longa sobre a tabela inteira.
   *
   * Roda CROSS-TENANT por construção (o backfill varre a base toda), então
   * recebe o par explicitamente em vez de ler o ALS.
   */
  async backfillBatch(input: {
    tenant_id: string;
    agent_id: string;
    limit: number;
  }): Promise<{ created: number }> {
    const result = await db.execute<{ id: string }>(sql`
      WITH candidatos AS (
        SELECT m.id, m.tenant_id, m.agent_id, m.conversa_id, m.channel_id, m.processada_em
        FROM ${mensagens} m
        WHERE m.tenant_id = ${input.tenant_id}
          AND m.agent_id = ${input.agent_id}
          AND m.direcao = 'in'
          AND NOT EXISTS (
            SELECT 1 FROM ${agent_turn_inputs} i WHERE i.mensagem_id = m.id
          )
        ORDER BY m.created_at
        LIMIT ${input.limit}
      ),
      novos AS (
        INSERT INTO ${agent_turns} (
          tenant_id, agent_id, conversa_id, channel_id, representative_message_id,
          status, outcome, completed_at, next_attempt_at
        )
        SELECT
          c.tenant_id, c.agent_id, c.conversa_id, c.channel_id, c.id,
          CASE WHEN c.processada_em IS NOT NULL THEN 'completed' ELSE 'received' END,
          CASE WHEN c.processada_em IS NOT NULL THEN 'legacy_processed' ELSE NULL END,
          c.processada_em,
          CASE WHEN c.processada_em IS NULL THEN now() ELSE NULL END
        FROM candidatos c
        ON CONFLICT (representative_message_id) DO NOTHING
        RETURNING id, tenant_id, agent_id, representative_message_id
      )
      INSERT INTO ${agent_turn_inputs} (tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
      SELECT n.tenant_id, n.agent_id, n.id, n.representative_message_id, 0
      FROM novos n
      ON CONFLICT (mensagem_id) DO NOTHING
      RETURNING id
    `);
    return { created: result.rows.length };
  },

  /** Pares (tenant, agent) com inbound histórico ainda sem turno. */
  async listTenantAgentPairsPendingBackfill(): Promise<
    Array<{ tenant_id: string; agent_id: string; pending: number }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string; pending: string }>(sql`
      SELECT m.tenant_id, m.agent_id, count(*)::text AS pending
      FROM ${mensagens} m
      WHERE m.tenant_id IS NOT NULL
        AND m.agent_id IS NOT NULL
        AND m.direcao = 'in'
        AND NOT EXISTS (SELECT 1 FROM ${agent_turn_inputs} i WHERE i.mensagem_id = m.id)
      GROUP BY m.tenant_id, m.agent_id
    `);
    return Array.from(
      result.rows as unknown as Array<{
        tenant_id: string;
        agent_id: string;
        pending: string;
      }>,
    ).map((r) => ({ tenant_id: r.tenant_id, agent_id: r.agent_id, pending: Number(r.pending) }));
  },
};

// ─── internals ───────────────────────────────────────────────────────────────

async function createTurnForMessage(
  tx: Executor,
  args: {
    mensagem: Pick<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'conversa_id' | 'channel_id'>;
    deadline_at: Date | null;
  },
): Promise<AgentTurn> {
  const { mensagem } = args;
  const guarded = applyTenantGuard({
    conversa_id: mensagem.conversa_id ?? null,
    channel_id: mensagem.channel_id ?? null,
    representative_message_id: mensagem.id,
    status: 'received' as const,
    deadline_at: args.deadline_at,
  });
  const inserted = await tx
    .insert(agent_turns)
    .values(guarded)
    .onConflictDoNothing({ target: agent_turns.representative_message_id })
    .returning();

  const turn = inserted[0] ?? (await findTurnByRepresentative(tx, mensagem));
  if (!turn) {
    // Só alcançável se a row sumiu entre o conflito e a releitura — falha alto
    // em vez de devolver um turno inventado.
    throw new Error(
      `agentTurnsRepo: turno de received não pôde ser criado nem relido para a mensagem ${mensagem.id}`,
    );
  }
  await tx
    .insert(agent_turn_inputs)
    .values(
      applyTenantGuard({
        turn_id: turn.id,
        mensagem_id: mensagem.id,
        ingress_seq: 0,
      }),
    )
    .onConflictDoNothing();
  return turn;
}

async function findTurnByRepresentative(
  tx: Executor,
  mensagem: Pick<Mensagem, 'id'>,
): Promise<AgentTurn | null> {
  const { tenant_id, agent_id } = scope();
  const rows = await tx
    .select()
    .from(agent_turns)
    .where(
      and(
        eq(agent_turns.tenant_id, tenant_id),
        eq(agent_turns.agent_id, agent_id),
        eq(agent_turns.representative_message_id, mensagem.id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * O UPDATE compare-and-swap + (quando terminal) a projeção legada, na MESMA
 * transação. Zero rows -> releitura para classificar o conflito.
 */
async function runTransition(args: {
  turn_id: string;
  to: TurnStatus;
  outcome: TurnOutcome | null;
  sources: readonly TurnStatus[];
  expected_version?: number;
  expected_claim_token?: string;
  patch: TurnTransitionPatch;
}): Promise<TurnTransitionResult> {
  const { tenant_id, agent_id } = scope();
  const terminal = isTerminalTurnStatus(args.to);

  return withTx(async (tx) => {
    const set: Record<string, unknown> = {
      status: args.to,
      outcome: args.outcome,
      state_version: sql`${agent_turns.state_version} + 1`,
      updated_at: sql`now()`,
    };
    const stamp = STATE_TIMESTAMP[args.to];
    if (stamp) set[stamp] = sql`now()`;
    if (args.patch.bumpAttempt) set['attempt_count'] = sql`${agent_turns.attempt_count} + 1`;
    if (args.patch.conversa_id !== undefined) set['conversa_id'] = args.patch.conversa_id;
    if (args.patch.channel_id !== undefined) set['channel_id'] = args.patch.channel_id;
    if (args.patch.next_attempt_at !== undefined) {
      set['next_attempt_at'] = args.patch.next_attempt_at;
    }
    if (args.patch.last_error_code !== undefined) {
      set['last_error_code'] = args.patch.last_error_code;
    }
    if (args.patch.last_error_summary !== undefined) {
      set['last_error_summary'] = args.patch.last_error_summary;
    }
    if (args.patch.outbound_message_id !== undefined) {
      set['outbound_message_id'] = args.patch.outbound_message_id;
    }
    if (args.patch.deadline_at !== undefined) set['deadline_at'] = args.patch.deadline_at;
    if (args.patch.superseded_by_turn_id !== undefined) {
      set['superseded_by_turn_id'] = args.patch.superseded_by_turn_id;
    }
    // Devolução da posse no MESMO statement (#504). O trio é all-or-nothing —
    // a CHECK `agent_turns_claim_trio_chk` (migration 108) recusaria escrever
    // só parte dele.
    if (args.patch.releaseClaim) {
      set['claimed_by'] = null;
      set['claim_token'] = null;
      set['lease_expires_at'] = null;
    }

    const updated = await tx
      .update(agent_turns)
      .set(set as never)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.id, args.turn_id),
          inArray(agent_turns.status, [...args.sources]),
          ...(args.expected_version !== undefined
            ? [eq(agent_turns.state_version, args.expected_version)]
            : []),
          // FENCING: a tentativa só grava enquanto for a dona do turno.
          ...(args.expected_claim_token !== undefined
            ? [eq(agent_turns.claim_token, args.expected_claim_token)]
            : []),
        ),
      )
      .returning();

    const turn = updated[0];
    if (!turn) {
      incCounter('maia_turn_state_conflicts_total', {
        transition: transitionLabel('any', args.to),
      });
      const current = await tx
        .select({
          status: agent_turns.status,
          state_version: agent_turns.state_version,
          claim_token: agent_turns.claim_token,
          claimed_by: agent_turns.claimed_by,
        })
        .from(agent_turns)
        .where(
          and(
            eq(agent_turns.tenant_id, tenant_id),
            eq(agent_turns.agent_id, agent_id),
            eq(agent_turns.id, args.turn_id),
          ),
        )
        .limit(1);
      const row = current[0];
      if (!row) return { ok: false as const, conflict: 'not_found' as const, to: args.to };
      // Classificação: token divergente é FENCING, não corrida de estado. A
      // ordem importa — um zumbi cujo sucessor já mudou o estado casaria nos
      // DOIS predicados, e reportá-lo como `state_mismatch` esconderia a única
      // evidência de que houve takeover.
      if (args.expected_claim_token !== undefined && row.claim_token !== args.expected_claim_token) {
        incCounter('maia_turn_fence_rejected_total', { operation: `transition_${args.to}` });
        return {
          ok: false as const,
          conflict: 'stale_claim' as const,
          to: args.to,
          current_status: row.status as TurnStatus,
          current_claim_token: row.claim_token,
          current_claimed_by: row.claimed_by,
        };
      }
      return {
        ok: false as const,
        conflict: 'state_mismatch' as const,
        to: args.to,
        current_status: row.status as TurnStatus,
        current_state_version: Number(row.state_version),
      };
    }

    if (terminal) {
      // Projeção de compatibilidade (§6): TODA transição terminal preenche
      // `processada_em` das mensagens do turno que ainda estão pendentes, na
      // MESMA transação do CAS. Estado não-terminal jamais escreve aqui — é o
      // que faz `retryable` continuar visível para o recovery legado.
      await tx
        .update(mensagens)
        .set({ processada_em: sql`now()` })
        .where(
          and(
            eq(mensagens.tenant_id, tenant_id),
            eq(mensagens.agent_id, agent_id),
            isNull(mensagens.processada_em),
            inArray(
              mensagens.id,
              tx
                .select({ id: agent_turn_inputs.mensagem_id })
                .from(agent_turn_inputs)
                .where(
                  and(
                    eq(agent_turn_inputs.tenant_id, tenant_id),
                    eq(agent_turn_inputs.agent_id, agent_id),
                    eq(agent_turn_inputs.turn_id, args.turn_id),
                  ),
                ),
            ),
          ),
        );
    }

    incCounter('maia_turn_transitions_total', {
      from: args.sources.length === 1 ? args.sources[0]! : 'any',
      to: args.to,
      outcome: args.outcome ?? 'none',
    });
    return {
      ok: true as const,
      turn,
      from: (args.sources.length === 1 ? args.sources[0]! : 'any') as TurnStatus,
      to: args.to,
    };
  });
}

function recoveryReasonFor(turn: AgentTurn): TurnRecoveryReason {
  if (turn.status === 'received') return 'received_stale';
  if (turn.status === 'queued') return 'queued_unclaimed';
  if (turn.status === 'retryable') return 'retry_due';
  return 'lease_expired';
}

/** Lista dos estados terminais, reexportada para consumidores do repositório. */
export { TERMINAL_TURN_STATUSES };
