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
    };

/** Candidato de recovery: o turno + o motivo pelo qual foi eleito. */
export type RecoverableTurn = { turn: AgentTurn; reason: TurnRecoveryReason };

/** Campos operacionais que uma transição pode carregar junto do estado. */
export type TurnTransitionPatch = {
  conversa_id?: string | null;
  channel_id?: string | null;
  next_attempt_at?: Date | null;
  last_error_code?: string | null;
  last_error_summary?: string | null;
  outbound_message_id?: string | null;
  deadline_at?: Date | null;
  /** Incrementa `attempt_count` no mesmo UPDATE (retry). */
  bumpAttempt?: boolean;
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
   */
  async transitionTurn(input: {
    turn_id: string;
    to: TurnStatus;
    outcome?: TurnOutcome | null;
    expected_statuses?: readonly TurnStatus[];
    expected_version?: number;
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

    return runTransition({
      turn_id: input.turn_id,
      to: input.to,
      outcome,
      sources,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: input.patch ?? {},
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

  /** `claimed -> running` (execução efetivamente iniciada, conta a tentativa). */
  async markRunning(input: {
    turn_id: string;
    conversa_id?: string | null;
    channel_id?: string | null;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'running',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: {
        bumpAttempt: true,
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
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'outbound_pending',
      expected_statuses: ['running'],
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { outbound_message_id: input.outbound_message_id },
    });
  },

  /** `running | outbound_pending -> completed` com outcome de conclusão. */
  async completeTurnTx(input: {
    turn_id: string;
    outcome: TurnOutcome;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'completed',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { next_attempt_at: null },
    });
  },

  /** Descarte intencional por regra explícita (`received | running -> ignored`). */
  async markIgnored(input: {
    turn_id: string;
    outcome: TurnOutcome;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'ignored',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { next_attempt_at: null },
    });
  },

  /** Turno incorporado a outro pelo debounce (`received | queued -> superseded`). */
  async markSuperseded(input: {
    turn_id: string;
    expected_version?: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'superseded',
      outcome: 'merged_into_turn',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
        : {}),
      patch: { next_attempt_at: null },
    });
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
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'retryable',
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
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
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'dead_letter',
      outcome: input.outcome,
      ...(input.expected_version !== undefined
        ? { expected_version: input.expected_version }
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
        ),
      )
      .returning();

    const turn = updated[0];
    if (!turn) {
      incCounter('maia_turn_state_conflicts_total', {
        transition: transitionLabel('any', args.to),
      });
      const current = await tx
        .select({ status: agent_turns.status, state_version: agent_turns.state_version })
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
