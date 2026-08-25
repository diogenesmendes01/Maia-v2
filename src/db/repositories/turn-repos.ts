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
import { and, asc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, pgErrorCode, pgErrorConstraint, withTx } from '../client.js';
import {
  agent_stream_sequences,
  agent_turns,
  agent_turn_inputs,
  mensagens,
} from '../schema.js';
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
import {
  CLAIMABLE_STATUSES,
  FENCED_WRITE_STATUSES,
  LEASE_TAKEOVER_STATUSES,
  STREAM_EXCLUSION_CONSTRAINT,
  STREAM_OCCUPYING_STATUSES,
  type ClaimRejection,
  type ClaimResult,
  type LeaseRenewalResult,
} from '@/runtime/turns/claim.js';
import { recordStreamBlocked, recordStreamFifoViolation } from '@/runtime/turns/stream-metrics.js';
import {
  statusList,
  turnWriteConditions,
  type TurnWriteFence,
} from './turn-fence-sql.js';
// #626 — a REGRA FIFO, num módulo puro. Os QUATRO consumidores dela neste
// arquivo — o `WHERE` de `claimNextEligibleTurn`, o filtro de
// `findRecoverableTurns`, o dispatcher cross-tenant e o canário
// `listNonHeadTurns` — chamam estas funções; nenhum monta predicado próprio.
// `tests/unit/runtime/stream-head-of-line-contract.spec.ts` conta as chamadas.
import {
  earlierLiveTurnCount,
  earlierLiveTurnProbe,
  streamHeadOfLineNotExists,
} from './stream-head-sql.js';
// A flag é lida por `contractEnv`, e não por `@/config/env.js`, pela MESMA
// razão de `conversation-repos.ts` (#596): este arquivo é alcançado pelo
// console via `conversation-repos`, e `tests/unit/config/admin-import-boundary.spec.ts`
// proíbe que o grafo compartilhado valide o subset `runtime` no boot — o que
// faria o console exigir as seis `BACKUP_*` num processo que nunca roda backup.
import { contractEnv } from '@/config/contract-env.js';

/** SQLSTATE de violação de unique. Ver `pgErrorCode` em `../client.ts`. */
const PG_UNIQUE_VIOLATION = '23505';

/** Colunas devolvidas pelo `RETURNING` do claim atômico. */
type ClaimRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: string;
  attempt_count: number | string;
  claim_token: string;
  claimed_by: string;
  claimed_at: string;
  lease_expires_at: string;
  state_version: number | string;
};

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
   * #504 — a transição foi REJEITADA PELO FENCE: o `claim_token` exigido não é
   * mais o vigente, ou a lease desta tentativa já venceu.
   *
   * É deliberadamente distinto de `state_mismatch`. `state_mismatch` diz "o
   * turno andou"; `stale_claim` diz "você não é mais o dono" — e a reação certa
   * é oposta: no primeiro caso relemos e podemos tentar de novo, no segundo
   * temos de PARAR, porque outro worker (ou o recovery) assumiu a tentativa e
   * insistir duplicaria o trabalho. Confundir os dois transformaria o fence
   * numa sugestão.
   */
  | {
      ok: false;
      conflict: 'stale_claim';
      to: TurnStatus;
      current_status: TurnStatus;
      current_state_version: number;
    }
  /**
   * #625 — a transição foi recusada pela EXCLUSÃO POR STREAM: outro turno da
   * mesma conversa já está ativo (`agent_turns_stream_active_uq`).
   *
   * Só alcançável por um caminho que escreva `claimed`/`running` FORA do claim
   * atômico — hoje, o `markClaimed` legado (`FEATURE_TURN_CLAIM=false`). O
   * claim de #504 tem tratamento próprio e devolve `stream_busy` como
   * `ClaimRejection`, não como conflito de transição.
   *
   * Existe como resultado TIPADO, e não como exceção vazando, porque a
   * alternativa é concreta e ruim: um `23505` cru viraria `TurnStateWriteError`
   * em modo autoritativo, o job do BullMQ falharia e o turno entraria em loop
   * de retry enquanto a conversa estivesse legitimamente ocupada — um turno
   * saudável consumindo tentativas até a DLQ por causa de uma corrida normal.
   */
  | { ok: false; conflict: 'stream_busy'; to: TurnStatus };

/**
 * #504 — projeção MÍNIMA devolvida pela leitura cross-tenant do escopo de um
 * job V2. Só colunas de escopo/identidade e dois timestamps operacionais;
 * nenhuma coluna de conteúdo atravessa esta fronteira.
 */
export type TurnJobScopeRow = {
  turn_tenant_id: string | null;
  turn_agent_id: string | null;
  turn_status: string;
  representative_message_id: string;
  queued_at: Date | string | null;
  /** `null` quando a mensagem representativa não existe (LEFT JOIN sem par). */
  message_tenant_id: string | null;
  message_agent_id: string | null;
  message_created_at: Date | string | null;
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
  /** Turno que absorveu este pelo debounce (só faz sentido em `superseded`). */
  superseded_by_turn_id?: string | null;
  /** Incrementa `attempt_count` no mesmo UPDATE (retry). */
  bumpAttempt?: boolean;
  /**
   * #504 — libera a posse na MESMA transação da transição terminal.
   *
   * Sem isto, um turno concluído continuaria carregando `claim_token` e
   * `lease_expires_at` no futuro: a leitura de diagnóstico mostraria um dono
   * para trabalho que já acabou, e a varredura de lease vencida acabaria
   * "recuperando" turnos terminais quando a lease finalmente passasse. Limpar
   * junto do CAS é o que mantém as duas leituras honestas.
   */
  clearClaim?: boolean;
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
    /**
     * #505 — a stream JÁ RESOLVIDA (fail-closed) pelo chamador. `null` quando o
     * protocolo de stream está desligado; nunca uma stream inventada aqui.
     */
    stream?: { stream_key: string; stream_key_version: number } | null;
  }): Promise<{ mensagem: Mensagem; turn: AgentTurn; ingress_seq: number | null }> {
    return withTx(async (tx) => {
      // ORDEM DELIBERADA: a sequência é alocada ANTES do INSERT da mensagem,
      // e as duas coisas estão na MESMA transação.
      //
      // O que essa combinação garante — e que a issue exige (§Acceptance:
      // "Redelivery do mesmo evento não recebe nova sequência"): se o INSERT
      // colidir na unique de dedup (`whatsapp_id`), a transação INTEIRA aborta,
      // e o `UPDATE` do contador aborta com ela. O número volta. A reentrega
      // relê a row original — que já carrega a sequência dela — em vez de
      // ganhar uma nova. Não existe caminho de compensação a lembrar de
      // escrever: é o rollback do Postgres fazendo o trabalho.
      //
      // A dedup PRECEDE a alocação também no nível de cima: `createInbound`
      // faz o pre-check por `whatsapp_id` ANTES de chamar aqui, então uma
      // reentrega comum nem chega a abrir transação (§Implementation Notes:
      // "Deduplicação do ingresso deve acontecer antes da alocação de nova
      // sequência").
      const ingress_seq = input.stream
        ? await allocateIngressSeq(tx, input.stream)
        : null;

      const guardedMensagem = applyTenantGuard({
        ...input.mensagem,
        channel_id: input.channel_id ?? (input.mensagem['channel_id'] as string | null) ?? null,
        stream_key: input.stream?.stream_key ?? null,
        stream_key_version: input.stream?.stream_key_version ?? null,
        ingress_seq,
      });
      const inserted = await tx
        .insert(mensagens)
        .values(guardedMensagem as never)
        .returning();
      const row = inserted[0]!;
      const turn = await createTurnForMessage(tx, {
        mensagem: row,
        deadline_at: input.deadline_at ?? null,
        stream:
          input.stream && ingress_seq !== null
            ? { ...input.stream, ingress_seq }
            : null,
      });
      incCounter('maia_turn_transitions_total', { from: 'none', to: 'received', outcome: 'none' });
      return { mensagem: row, turn, ingress_seq };
    });
  },

  /**
   * #505 — persiste a mensagem inbound COM stream/sequência, sem criar turno.
   *
   * É o caminho de `createInbound` quando `FEATURE_TURN_STATE_MACHINE` está
   * OFF. Existe para que a captura de ordem (fase shadow) NÃO dependa da flag
   * da máquina de estados: são dois rollouts independentes, e amarrá-los faria
   * o kill switch de um apagar a evidência do outro.
   */
  async createSequencedInboundTx(input: {
    mensagem: Record<string, unknown>;
    channel_id?: string | null;
    stream: { stream_key: string; stream_key_version: number };
  }): Promise<{ mensagem: Mensagem; ingress_seq: number }> {
    return withTx(async (tx) => {
      const ingress_seq = await allocateIngressSeq(tx, input.stream);
      const guardedMensagem = applyTenantGuard({
        ...input.mensagem,
        channel_id: input.channel_id ?? (input.mensagem['channel_id'] as string | null) ?? null,
        stream_key: input.stream.stream_key,
        stream_key_version: input.stream.stream_key_version,
        ingress_seq,
      });
      const inserted = await tx
        .insert(mensagens)
        .values(guardedMensagem as never)
        .returning();
      return { mensagem: inserted[0]!, ingress_seq };
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
   * #505 — ESTENDE as fronteiras de sequência do turno para cobrir os ingressos
   * que o debounce absorveu.
   *
   * Turno simples nasce com `first === last` (a mensagem representativa). Um
   * turno AGREGADO consome mais ingressos, e a issue exige que ele persista o
   * intervalo (§Relação entre ingressos e turnos), porque é o intervalo — não a
   * mensagem representativa — que o head-of-line de fases posteriores compara.
   *
   * ─── O predicado que impede a fronteira de atravessar streams ────────────
   *
   * `m.stream_key = agent_turns.stream_key` no subselect é a parte que importa.
   * Sem ele, uma mensagem de OUTRA conversa (por bug de agrupamento, por replay
   * manual, por um `mensagem_ids` mal montado) alargaria o intervalo deste
   * turno até cobrir sequências que ele nunca consumiu — e o head-of-line
   * passaria a barrar, ou liberar, a stream errada. Com ele, uma mensagem de
   * fora simplesmente não entra na agregação: o `max`/`min` a ignora e a
   * fronteira não se move. É fail-closed por construção, não por validação do
   * chamador.
   *
   * `GREATEST`/`LEAST` do Postgres IGNORAM NULL, então uma lista que não casa
   * com nada deixa as fronteiras exatamente como estavam — nenhuma escrita
   * espúria, nenhum `NULL` acidental.
   *
   * NÃO é uma transição de estado: não toca `status`, não incrementa
   * `state_version`, não passa pelo CAS. É a atualização de um dado
   * DERIVADO da composição do batch, e submetê-la ao compare-and-swap faria uma
   * absorção concorrente falhar por conflito de versão sem que nada de estado
   * tivesse mudado.
   *
   * Devolve `false` quando nada foi atualizado — turno inexistente, de outro
   * escopo, ou ainda sem `stream_key` (anterior ao protocolo).
   */
  async extendTurnStreamBoundaryTx(input: {
    turn_id: string;
    mensagem_ids: readonly string[];
  }): Promise<boolean> {
    if (input.mensagem_ids.length === 0) return false;
    const { tenant_id, agent_id } = scope();
    const ids = sql.join(
      input.mensagem_ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await db.execute<{ id: string }>(sql`
      UPDATE ${agent_turns}
      SET first_ingress_seq = LEAST(
            ${agent_turns}.first_ingress_seq,
            (SELECT min(m.ingress_seq) FROM ${mensagens} m
              WHERE m.tenant_id = ${tenant_id}
                AND m.agent_id = ${agent_id}
                AND m.id IN (${ids})
                AND m.stream_key = ${agent_turns}.stream_key)
          ),
          last_ingress_seq = GREATEST(
            ${agent_turns}.last_ingress_seq,
            (SELECT max(m.ingress_seq) FROM ${mensagens} m
              WHERE m.tenant_id = ${tenant_id}
                AND m.agent_id = ${agent_id}
                AND m.id IN (${ids})
                AND m.stream_key = ${agent_turns}.stream_key)
          ),
          updated_at = now()
      WHERE ${agent_turns}.id = ${input.turn_id}::uuid
        AND ${agent_turns}.tenant_id = ${tenant_id}
        AND ${agent_turns}.agent_id = ${agent_id}
        AND ${agent_turns}.stream_key IS NOT NULL
        AND ${agent_turns}.first_ingress_seq IS NOT NULL
      RETURNING ${agent_turns}.id
    `);
    return Array.from(result.rows as unknown as Array<{ id: string }>).length === 1;
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
   * @param input.expected_claim_token #504 — quando fornecido, o UPDATE também
   *   exige `claim_token = <token>` **e** `lease_expires_at > now()`: é o
   *   FENCE. As duas condições são necessárias. Só o token não basta, porque um
   *   worker cuja lease venceu e que ninguém sucedeu ainda continuaria portando
   *   um token que casa — e escreveria como dono de uma posse que já não tem.
   *   Só a lease não basta, porque o sucessor renova a lease e o zumbi passaria.
   *   Falha aqui é `stale_claim`, nunca `state_mismatch`.
   * @param input.absorber_fence #504 (decisão do dono) — o fence pertence a
   *   OUTRA linha: a transição só passa se o turno ABSORVEDOR nomeado aqui
   *   ainda tiver este `claim_token` e lease viva. Usado pela absorção de
   *   irmão do debounce, onde a linha que muda (o irmão) não tem — e não
   *   precisa ter — claim próprio. MUTUAMENTE EXCLUSIVO com
   *   `expected_claim_token`: uma gravação tem UMA autoridade, e declarar as
   *   duas significa que quem chamou não sabe de quem é a posse.
   */
  async transitionTurn(input: {
    turn_id: string;
    to: TurnStatus;
    outcome?: TurnOutcome | null;
    expected_statuses?: readonly TurnStatus[];
    expected_version?: number;
    expected_claim_token?: string;
    absorber_fence?: { turn_id: string; claim_token: string };
    patch?: TurnTransitionPatch;
    manual?: boolean;
  }): Promise<TurnTransitionResult> {
    if (input.expected_claim_token !== undefined && input.absorber_fence !== undefined) {
      throw new Error(
        'transitionTurn: expected_claim_token e absorber_fence são mutuamente exclusivos — ' +
          'uma gravação tem UMA autoridade (a própria tentativa OU o turno absorvedor).',
      );
    }
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
      ...(input.expected_claim_token !== undefined
        ? { expected_claim_token: input.expected_claim_token }
        : {}),
      ...(input.absorber_fence !== undefined
        ? { absorber_fence: input.absorber_fence }
        : {}),
      patch: input.patch ?? {},
    });
  },

  // ─── #504 — claim atômico, lease e fencing ───────────────────────────────

  /**
   * CLAIM ATÔMICO: uma ÚNICA declaração SQL decide o dono da tentativa.
   *
   * A garantia inteira desta issue mora na forma desta query. Duas propriedades
   * a sustentam, e nenhuma das duas sobrevive a "SELECT elegível" seguido de
   * "UPDATE":
   *
   *  1. **Um único UPDATE ... WHERE ... RETURNING.** Sob READ COMMITTED, dois
   *     workers que disputam a mesma row serializam no lock de row: o segundo
   *     bloqueia e, quando o primeiro faz commit, RE-AVALIA o WHERE contra a
   *     versão nova da row (EvalPlanQual). Como o vencedor deixou
   *     `lease_expires_at` no futuro, o predicado de takeover do perdedor passa
   *     a ser falso e ele volta ZERO linhas. Com SELECT-depois-UPDATE os dois
   *     leriam o mesmo estado elegível e os dois escreveriam.
   *
   *  2. **Todo relógio é o do PostgreSQL** (`now()`), nunca `Date.now()` do
   *     processo. Elegibilidade por lease é comparação de instantes entre
   *     máquinas diferentes; com relógios locais, um nó adiantado em 30s toma
   *     leases ainda vivas — takeover falso, ou seja, execução dupla.
   *
   * Elegibilidade DO TURNO (issue #504 §Claim atômico):
   *   - `received`/`queued`: ninguém possui;
   *   - `retryable` com `next_attempt_at` vencido (ou nulo): o backoff é do
   *     PostgreSQL, não da BullMQ;
   *   - `claimed`/`running` com `lease_expires_at <= now()`: takeover de dono
   *     morto. `outbound_pending` NÃO entra — a resposta já foi comprometida.
   *
   * Elegibilidade DA STREAM (issue #626, fatia C da #505 — **o head-of-line**):
   *   - não existe turno ANTERIOR não terminal na mesma stream
   *     (`first_ingress_seq` menor). É `streamHeadOfLineNotExists`, a mesma
   *     função que filtra os candidatos do recovery — a issue proíbe duas
   *     cópias da regra, porque a divergência entre elas só aparece durante um
   *     recovery, que é o pior momento para descobri-la;
   *   - e, pela fatia B, não existe outro turno ATIVO com lease viva — quem
   *     recusa esse é o índice `agent_turns_stream_active_uq` (`23505` ⇒
   *     `stream_busy`).
   *
   * As duas condições da issue são, portanto, uma no `WHERE` e outra no índice,
   * e a ordem em que falham é observável: o `WHERE` roda primeiro, então um
   * turno POSTERIOR cuja conversa está ocupada devolve `not_head` (a fila) e
   * não `stream_busy` (a posse). `stream_busy` sobra para o que o head-of-line
   * não consegue ordenar — turnos sem `first_ingress_seq`, sequências
   * empatadas por backfill, e a janela em que a flag está desligada.
   *
   * Efeito atômico do claim: incrementa `attempt` (a tentativa CANÔNICA nasce
   * aqui, não em `markRunning`), gera `claim_token` novo, grava `claimed_by`,
   * `claimed_at`, `heartbeat_at` e `lease_expires_at`, e transiciona para
   * `claimed`.
   *
   * Resultado vazio significa "não adquirido" — não é erro, e NÃO autoriza
   * processar. `not_found` distingue "não existe neste escopo" de "existe e não
   * está elegível", que é a diferença entre um bug de roteamento e uma corrida
   * normal.
   *
   * ─── #625 — a EXCLUSÃO POR STREAM entra aqui, e por que ela é uma TX ──────
   *
   * A #504 garantia exclusão por TURNO. Faltava a exclusão por CONVERSA: dois
   * turnos DIFERENTES da mesma stream podiam ser reivindicados por réplicas
   * diferentes, no mesmo instante (falha nº 2 da lista da #505). O PostgreSQL
   * não expressa "no máximo um turno com lease viva por stream" numa constraint
   * — uma constraint não depende de `now()`, e uma lease vence sem que nenhuma
   * escrita aconteça. A issue-mãe prescreve, então, a combinação de duas
   * metades, e este método executa as duas NA MESMA TRANSAÇÃO:
   *
   *   PASSO 1 (metade TEMPORAL) — recupera os claims EXPIRADOS da stream deste
   *     turno, devolvendo-os a `retryable`. Sem isto, a linha `claimed` de um
   *     worker morto ocuparia a chave do índice e a stream ficaria bloqueada
   *     PARA SEMPRE: o índice deixaria de ser proteção e viraria o defeito.
   *
   *   PASSO 2 (metade ESTRUTURAL) — o claim de sempre. O índice único parcial
   *     `agent_turns_stream_active_uq` (migration 124) é quem DECIDE: se outro
   *     turno da stream já está ativo com lease viva, este UPDATE levanta
   *     `23505` e vira `stream_busy`.
   *
   * ─── Por que a mesma transação, e não um sweeper à parte ────────────────
   *
   * O critério de pronto da issue é literal: "Claim expirado é recuperado
   * dentro da transação, não por sweeper à parte". A razão é uma corrida:
   * entre um sweeper recuperar a linha vencida e este claim rodar, um TERCEIRO
   * worker pode reivindicar aquele turno de volta — e aí o índice recusa este
   * claim por um motivo legítimo, mas a stream ficou parada um ciclo inteiro do
   * sweeper por nada. Dentro da transação, "liberar" e "ocupar" são o mesmo
   * instante lógico: ninguém observa a stream vazia e ninguém a ocupa no vão.
   *
   * ─── Por que a recuperação NÃO passa por `transitionTurn` ───────────────
   *
   * `transitionTurn` é compare-and-swap sobre UMA row conhecida, com versão
   * esperada — e aqui nem sabemos quais rows existem antes de olhar. O par
   * (from, to) continua sendo do contrato: `claimed -> retryable` e
   * `running -> retryable` são arestas de `TURN_TRANSITIONS`, e
   * `tests/unit/runtime/stream-exclusion-contract.spec.ts` falha se alguém as
   * remover. `claimNextEligibleTurn` já era, desde #504, o outro ponto do
   * módulo que escreve `status` sem passar pelo CAS genérico, pela mesma razão: a
   * elegibilidade do claim não cabe na tabela de transições.
   *
   * ─── A ordem de lock, e a janela em que ela importa ────────────────────
   *
   * O PASSO 1 tranca as linhas ATIVAS da stream com `FOR UPDATE` numa CTE
   * `MATERIALIZED` **ordenada por `id`**, e tranca INCLUSIVE o próprio alvo (a
   * exclusão do alvo mora no `WHERE` do UPDATE, onde ela não afeta locks).
   *
   * Com o índice de pé, o conjunto trancado tem NO MÁXIMO uma linha por stream
   * — a exclusão garante isso —, e nesse regime não há ordem a escolher. A
   * ordenação existe para a janela em que o conjunto pode ter mais de uma
   * linha: antes da migration 124 ser aplicada, depois de um rollback, ou com
   * o índice em estado inválido. Aí duas réplicas recuperando o claim expirado
   * UMA DA OUTRA visitariam as linhas na ordem que o plano escolhesse e
   * fechariam ciclo (`40P01`). Com o `ORDER BY`, elas adquirem os mesmos locks
   * na mesma ordem e uma espera pela outra.
   *
   * `MATERIALIZED` é o que garante a ordenação: uma CTE inlinada pode ser
   * replanejada, e a ordem — a única propriedade de que dependemos aqui —
   * se perderia sem nenhum sintoma até a primeira janela de carga.
   *
   * A transação é CURTA de propósito — dois statements, nenhuma chamada de rede
   * no meio. Ela segura locks de linha de UMA stream; streams distintas não se
   * tocam, que é a exigência "sem lock global por tenant, agente ou fila".
   */
  async claimNextEligibleTurn(input: {
    turn_id: string;
    worker_id: string;
    lease_ms: number;
  }): Promise<ClaimResult> {
    try {
      return await withTx((tx) => claimWithinStreamExclusion(tx, input));
    } catch (err) {
      // NARROW de propósito: só o índice de exclusão por stream vira
      // `stream_busy`. `agent_turns` tem outras uniques
      // (`agent_turns_representative_uq`, `agent_turns_scope_id_uq`), e mapear
      // todo `23505` para "stream ocupada" transformaria um defeito de
      // idempotência do ingresso numa corrida rotineira na métrica — a falha
      // ficaria invisível exatamente onde ela é grave.
      if (
        pgErrorCode(err) === PG_UNIQUE_VIOLATION &&
        pgErrorConstraint(err) === STREAM_EXCLUSION_CONSTRAINT
      ) {
        incCounter('maia_turn_claim_total', { result: 'stream_busy' });
        return { ok: false, reason: 'stream_busy' };
      }
      throw err;
    }
  },

  /**
   * Renova a lease do claim VIGENTE. É o heartbeat.
   *
   * Três condições, todas necessárias:
   *   - `claim_token = <o meu>` — só o dono renova (fencing);
   *   - `status` ainda gravável — turno terminal não tem lease a renovar;
   *   - `lease_expires_at > now()` — **uma lease VENCIDA não se renova.**
   *
   * A terceira é a que implementa "um worker que recuperar conectividade após
   * perder o lease não pode retomá-lo implicitamente" (issue §Lease). Sem ela,
   * um processo que ficou cinco minutos em GC voltaria, renovaria como se nada
   * tivesse acontecido e continuaria escrevendo — mesmo que ninguém tenha
   * tomado o turno ainda. O sucessor não ter chegado não devolve a posse a quem
   * a perdeu.
   *
   * NÃO incrementa `state_version`: heartbeat não é transição de estado. Se
   * incrementasse, cada batida invalidaria o CAS otimista que o caller carrega
   * e toda conclusão de turno longo falharia por versão obsoleta.
   */
  async renewTurnLease(input: {
    turn_id: string;
    claim_token: string;
    lease_ms: number;
  }): Promise<LeaseRenewalResult> {
    const { tenant_id, agent_id } = scope();
    const leaseSeconds = input.lease_ms / 1000;
    const result = await db.execute<{ lease_expires_at: string; heartbeat_at: string }>(sql`
      UPDATE ${agent_turns}
         SET lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
             heartbeat_at     = now(),
             updated_at       = now()
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND id          = ${input.turn_id}
         AND claim_token = ${input.claim_token}::uuid
         AND status      IN (${statusList(FENCED_WRITE_STATUSES)})
         AND lease_expires_at > now()
      RETURNING lease_expires_at, heartbeat_at
    `);
    const row = (
      result.rows as unknown as Array<{ lease_expires_at: string; heartbeat_at: string }>
    )[0];
    if (!row) {
      incCounter('maia_turn_lease_heartbeat_total', { result: 'token_mismatch' });
      return { ok: false, reason: 'token_mismatch' };
    }
    incCounter('maia_turn_lease_heartbeat_total', { result: 'renewed' });
    return {
      ok: true,
      lease_expires_at: new Date(row.lease_expires_at),
      heartbeat_at: new Date(row.heartbeat_at),
    };
  },

  /**
   * Libera a posse EXPLICITAMENTE (shutdown gracioso, ou tentativa abortada).
   *
   * Vence a lease AGORA (`lease_expires_at = now()`) em vez de apagar o
   * `claim_token`. Duas razões:
   *
   *  - o sucessor pode reivindicar no próximo tick, sem esperar o TTL — é o que
   *    faz um deploy não custar um TTL de latência por turno em voo;
   *  - `claimed_by`/`claim_token` sobrevivem para a forense ("quem tinha este
   *    turno quando o pod morreu?"). Apagá-los devolveria a row a um estado que
   *    finge que nunca houve dono.
   *
   * Isto NÃO reabre a porta para o worker antigo escrever: toda gravação fenced
   * também exige `lease_expires_at > now()`, então quem libera perde o direito
   * de escrever no mesmo instante em que libera.
   *
   * Idempotente e fenced: só o dono corrente libera.
   */
  async releaseTurnClaim(input: {
    turn_id: string;
    claim_token: string;
  }): Promise<{ released: boolean }> {
    const { tenant_id, agent_id } = scope();
    const result = await db.execute<{ id: string }>(sql`
      UPDATE ${agent_turns}
         SET lease_expires_at = now(),
             updated_at       = now()
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND id          = ${input.turn_id}
         AND claim_token = ${input.claim_token}::uuid
         AND status      IN (${statusList(FENCED_WRITE_STATUSES)})
      RETURNING id
    `);
    return { released: result.rows.length === 1 };
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
   * `received | queued -> claimed` SEM lease — o claim LEGADO de #503.
   *
   * Continua existindo porque `FEATURE_TURN_CLAIM` é um kill switch de verdade:
   * desligada, o runtime volta a este caminho. Ele NÃO é exclusão mútua e nunca
   * foi — duas réplicas ainda entram no mesmo turno. Quem dá exclusão mútua é
   * `claimNextEligibleTurn`.
   *
   * Deliberadamente NÃO admite `claimed`/`running` como origem: o takeover é
   * privilégio do claim com lease, que sabe verificar se o dono morreu. Se esta
   * porta aceitasse essas origens, o caminho legado poderia rebaixar um turno
   * com dono VIVO.
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
   * @param input.bump_attempt conta a tentativa neste UPDATE. `true` (default)
   *   preserva o comportamento de #503. O caminho de #504 passa `false`, porque
   *   ali a tentativa canônica JÁ foi incrementada pelo `claimNextEligibleTurn`
   *   — contar nos dois lugares dobraria `attempt_count` e esgotaria `MAX_TURN_ATTEMPTS`
   *   na metade das tentativas reais.
   * @param input.expected_claim_token fence da tentativa (#504).
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
      // A posse NÃO é liberada aqui: `outbound_pending` continua sendo uma
      // gravação da MESMA tentativa (o outbox de #506 ainda vai finalizar), e
      // soltar o fence agora deixaria a janela mais perigosa da máquina —
      // resposta comprometida, dono indefinido — sem dono.
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
      patch: { next_attempt_at: null, clearClaim: true },
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
      patch: { next_attempt_at: null, clearClaim: true },
    });
  },

  /**
   * AUTO-SUPERSESSÃO: o turno declara a si mesmo incorporado a outro
   * (`received | queued -> superseded`), sem nomear o absorvedor.
   *
   * É a MESMA tentativa gravando o próprio desfecho, então o fence é o comum a
   * toda gravação da tentativa: o `claim_token` VIGENTE DO PRÓPRIO TURNO. Sem
   * ele esta porta era a única transição terminal sem posse — um worker que já
   * havia perdido a lease conseguia fechar o turno como `superseded` por cima
   * da tentativa do sucessor, e `superseded` é terminal, então o sucessor
   * perdia o turno sem que nada aparecesse como conflito.
   *
   * `expected_claim_token` é opcional pela MESMA razão que nas outras
   * transições: com `FEATURE_TURN_CLAIM` OFF não existe lease e não há token a
   * exigir (regime de #503). Quem decide se há posse a exigir é
   * `resolveFence()` em `src/runtime/turns/lifecycle.ts`, e é lá — não aqui —
   * que a posse PERDIDA recusa a gravação antes mesmo de ir ao banco.
   */
  async markSupersededSelf(input: {
    turn_id: string;
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
      patch: { next_attempt_at: null, clearClaim: true },
    });
  },

  /**
   * ABSORÇÃO DE IRMÃO: o turno EXECUTOR da rajada de debounce absorve o turno
   * de uma mensagem irmã (`received | queued -> superseded`), gravando a
   * relação em `superseded_by_turn_id`.
   *
   * Aqui a linha que muda e a autoridade que manda mudá-la são DUAS LINHAS
   * DIFERENTES, e é isso que torna esta operação distinta da anterior:
   *
   *  - o FENCE é do ABSORVEDOR — `absorber_claim_token` + lease viva dele,
   *    verificados na MESMA declaração (ver `absorberFenceCondition`). Sem essa
   *    verificação, um worker zumbi (lease vencida, tentativa já sucedida)
   *    continuaria absorvendo turnos e apagando trabalho do sucessor;
   *  - o IRMÃO NÃO precisa de claim, e é por isso que não existe parâmetro para
   *    exigi-lo. O turno absorvido nunca foi reivindicado no caso normal
   *    (`claim_token IS NULL`), porque quem foi reivindicado foi o executor.
   *    Exigir claim do irmão tornaria a absorção legítima IMPOSSÍVEL no caminho
   *    comum;
   *  - o que decide a corrida entre duas absorções concorrentes é o
   *    COMPARE-AND-SWAP na linha do irmão: `expected_version` é OBRIGATÓRIO
   *    (não opcional como nas demais transições) exatamente para que ninguém
   *    possa omiti-lo por descuido — sem ele, duas absorções que leram o mesmo
   *    estado poderiam ambas se declarar vencedoras e a rajada produziria dois
   *    turnos executáveis disputando as mesmas mensagens.
   */
  async markSupersededByAbsorber(input: {
    /** O IRMÃO absorvido — a linha que muda. */
    turn_id: string;
    /** O ABSORVEDOR: turno executor da rajada. Persistido em `superseded_by_turn_id`. */
    absorbed_by_turn_id: string;
    /**
     * Posse do ABSORVEDOR. Ausente só no regime de #503 (`FEATURE_TURN_CLAIM`
     * OFF), onde não existe lease em lugar nenhum.
     */
    absorber_claim_token?: string;
    /** CAS na linha do irmão. OBRIGATÓRIO — ver acima. */
    expected_version: number;
  }): Promise<TurnTransitionResult> {
    return this.transitionTurn({
      turn_id: input.turn_id,
      to: 'superseded',
      outcome: 'merged_into_turn',
      expected_version: input.expected_version,
      ...(input.absorber_claim_token !== undefined
        ? {
            absorber_fence: {
              turn_id: input.absorbed_by_turn_id,
              claim_token: input.absorber_claim_token,
            },
          }
        : {}),
      patch: {
        next_attempt_at: null,
        clearClaim: true,
        superseded_by_turn_id: input.absorbed_by_turn_id,
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
        // A tentativa acabou: a posse volta ao pool JÁ, sem esperar o TTL. Um
        // turno `retryable` com lease viva ficaria invisível para o claim até o
        // vencimento, atrasando o retry por nada.
        clearClaim: true,
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
        clearClaim: true,
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

  /**
   * #504 §Contrato do job — a ÚNICA leitura CROSS-TENANT desta tabela feita a
   * pedido de um payload de fila, e a razão pela qual ela existe.
   *
   * Um job V2 carrega só `{version, turn_id}`. O consumidor precisa descobrir
   * QUEM é o dono antes de poder abrir contexto de tenant — é literalmente o
   * mesmo problema (e o mesmo padrão sancionado de entry-point) de
   * `channelsRepo.findByExternalCrossTenant` e
   * `mensagensRepo.findOwnerByIdCrossTenant`: quem descobre o escopo não pode
   * já estar escopado.
   *
   * O que este método faz para que essa exceção não vire um buraco:
   *
   *  1. **Projeção mínima.** Devolve `tenant_id`, `agent_id`, o id da mensagem
   *     representativa e dois timestamps operacionais. NENHUMA coluna de
   *     conteúdo — nem `last_error_summary`, nem conversa, nem a mensagem. Um
   *     chamador que resolva o turno errado não consegue LER nada de outro
   *     tenant por esta porta; no máximo descobre que o id existe.
   *  2. **Uma única declaração.** O escopo e o id da mensagem saem da MESMA
   *     row, no MESMO SELECT. Não existe janela entre "li o escopo" e "li a
   *     mensagem" na qual os dois pudessem vir de linhas diferentes.
   *  3. **O escopo da MENSAGEM vem junto.** `representative_message_id` NÃO
   *     tem foreign key (ver `migrations/097_agent_turns.sql`: só uma unique),
   *     então um turno do tenant A apontando para uma mensagem do tenant B é
   *     fisicamente representável. Trazer os dois pares no mesmo SELECT é o que
   *     permite ao resolvedor RECUSAR essa combinação em vez de atravessá-la —
   *     ver `src/runtime/turns/scope-resolver.ts`.
   *
   * O LEFT JOIN é deliberado: sem ele, um turno cuja mensagem sumiu seria
   * indistinguível de um turno inexistente, e os dois pedem reações diferentes
   * (o primeiro é corrupção de dado, o segundo é payload forjado ou retenção).
   */
  async findJobScopeByIdCrossTenant(turn_id: string): Promise<TurnJobScopeRow | null> {
    const result = await db.execute<TurnJobScopeRow>(sql`
      SELECT
        t.tenant_id                  AS turn_tenant_id,
        t.agent_id                   AS turn_agent_id,
        t.status                     AS turn_status,
        t.representative_message_id  AS representative_message_id,
        t.queued_at                  AS queued_at,
        m.tenant_id                  AS message_tenant_id,
        m.agent_id                   AS message_agent_id,
        m.created_at                 AS message_created_at
      FROM ${agent_turns} t
      LEFT JOIN ${mensagens} m ON m.id = t.representative_message_id
      WHERE t.id = ${turn_id}
      LIMIT 1
    `);
    return (result.rows as unknown as TurnJobScopeRow[])[0] ?? null;
  },

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
   *
   * ─── #626 — o recovery usa A MESMA REGRA FIFO do worker ──────────────────
   *
   * O filtro acima elege por ESTADO. Desde a fatia C ele também elege por
   * POSIÇÃO: `streamHeadOfLineNotExists` — a MESMA função que o `WHERE` de
   * `claimNextEligibleTurn` chama, não uma cópia dela.
   *
   * A issue é explícita sobre por quê: "duas cópias da regra de elegibilidade
   * divergem, e a divergência só aparece durante um recovery". O formato
   * concreto do defeito, se o filtro daqui não tivesse a regra: o varredor
   * rearma um turno POSTERIOR de uma conversa com fila, o job acorda, o claim
   * recusa com `not_head` e o job termina. Nada quebra — e é justamente isso
   * que o torna caro: a fila cresce, o Redis roda, a métrica de recovery diz
   * que houve trabalho, e a conversa não anda. O turno que precisava ser
   * rearmado (o head) talvez nem apareça, se o `limit` tiver sido consumido
   * pelos posteriores.
   *
   * A ordenação por `created_at` é mantida — dentro de uma stream ela e
   * `first_ingress_seq` concordam, e entre streams distintas não há ordem a
   * impor.
   *
   * Consequência assumida: uma stream cujo head está em `outbound_pending`
   * (não recuperável, e não terminal) some inteira desta lista até o outbox
   * destravar. É FIFO correto — e é observável por
   * `maia_stream_blocked_total{reason="stream_blocked"}`, que o claim emite.
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
          ...(headOfLineEnabled()
            ? [streamHeadOfLineNotExists(escopoSql(tenant_id, agent_id))]
            : []),
        ),
      )
      .orderBy(asc(agent_turns.created_at))
      .limit(limit);
    return rows.map((turn) => ({ turn, reason: recoveryReasonFor(turn) }));
  },

  /**
   * #626 — O CANÁRIO DO RECOVERY: quais destes turnos NÃO são o head-of-line da
   * sua stream?
   *
   * A resposta esperada é lista vazia, porque `findRecoverableTurns` já filtrou
   * por essa mesma regra. Perguntar de novo parece redundante — e é exatamente
   * por isso que serve: o valor não está na resposta, está em ela ser obtida
   * por um caminho DIFERENTE. O filtro é um predicado no `WHERE` de uma
   * consulta; esta é uma consulta separada sobre os ids que aquela devolveu. Se
   * alguém remover a regra do filtro, o `WHERE` deixa de barrar e este
   * `SELECT` acusa — que é o cenário que a issue nomeia ("a divergência só
   * aparece durante um recovery") e o que `maia_stream_fifo_violation_total`
   * `{stage="recovery"}` existe para contar.
   *
   * Uma consulta por VARREDURA, não por candidato: os ids entram todos de uma
   * vez. Numa varredura com o `limit` cheio (200) isso é uma sonda indexada por
   * turno, ainda dentro do orçamento de um job que já leu 200 linhas.
   */
  async listNonHeadTurns(
    turn_ids: readonly string[],
  ): Promise<Array<{ turn_id: string; earlier_live: number }>> {
    if (turn_ids.length === 0) return [];
    const { tenant_id, agent_id } = scope();
    const escopo = escopoSql(tenant_id, agent_id);
    const rows = await db
      .select({ id: agent_turns.id, earlier_live: earlierLiveTurnCount(escopo) })
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          inArray(agent_turns.id, [...turn_ids]),
          sql`NOT ${streamHeadOfLineNotExists(escopo)}`,
        ),
      );
    return rows.map((r) => ({ turn_id: r.id, earlier_live: Number(r.earlier_live) }));
  },

  /**
   * Enumeração CROSS-TENANT dos pares (tenant, agent) com turnos recuperáveis.
   * Roda FORA de contexto de tenant — é o dispatcher, como o de mensagens
   * (`listTenantAgentPairsWithUnprocessedOlderThan`, issue #345). O predicado
   * espelha EXATAMENTE `findRecoverableTurns`, para que um par só seja
   * enumerado quando o inner de fato teria trabalho — e desde #626 isso inclui
   * a regra FIFO, pela mesma função. Sem ela, um par cujos únicos candidatos
   * estão todos atrás de um head parado seria enumerado a cada varredura para
   * o inner devolver lista vazia.
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
        AND ${
          headOfLineEnabled()
            ? streamHeadOfLineNotExists({
                // CROSS-TENANT: o escopo vem das COLUNAS da própria linha, não
                // de parâmetros do ALS — este dispatcher roda fora de contexto
                // de tenant, como o de mensagens (#345). É exatamente por isso
                // que `stream-head-sql` recebe fragmentos e não strings: com
                // strings, este call site teria de escrever o predicado à mão,
                // e a segunda cópia da regra nasceria aqui.
                tenant: sql`${agent_turns}.tenant_id`,
                agent: sql`${agent_turns}.agent_id`,
                alvo: sql`${agent_turns}`,
              })
            : sql`TRUE`
        }
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

/**
 * #625 — PASSO 1 do claim: recupera os claims EXPIRADOS da stream deste turno.
 *
 * ─── O que "recuperar" significa, e por que `retryable` ──────────────────
 *
 * A linha vencida vai para `retryable` com `next_attempt_at = now()`. Três
 * consequências, todas queridas:
 *
 *   1. ela SAI do predicado do índice `agent_turns_stream_active_uq`, então a
 *      stream deixa de estar ocupada por um dono que não existe mais;
 *   2. ela continua ELEGÍVEL: o varredor de recovery já procura por
 *      `retryable` com `next_attempt_at` vencido (`findRecoverableTurns`), e o
 *      próprio claim aceita `retryable` direto. O trabalho não é descartado —
 *      só devolvido à fila;
 *   3. `state_version` avança, então qualquer CAS otimista que o worker morto
 *      ainda carregue passa a falhar.
 *
 * O `claim_token` e o `claimed_by` são PRESERVADOS de propósito, pelo mesmo
 * motivo de `releaseTurnClaim`: são a forense de "quem tinha este turno quando
 * o pod morreu?". Apagá-los devolveria a row a um estado que finge que nunca
 * houve dono. E eles não reabrem porta nenhuma — toda gravação fenced exige
 * `status IN (FENCED_WRITE_STATUSES)`, e `retryable` não está lá.
 *
 * `attempt_count` NÃO é incrementado: a tentativa morta já foi contada quando
 * ela foi reivindicada. Contar de novo aqui gastaria o orçamento de tentativas
 * do turno com o crash de um worker, e um turno inocente iria para DLQ por
 * causa de um deploy.
 *
 * ─── A ordem de lock ────────────────────────────────────────────────────
 *
 * A CTE `ativos` tranca TODAS as linhas ativas da stream — inclusive o próprio
 * alvo — em ordem de `id`. Trancar o alvo junto, e não excluí-lo do conjunto,
 * é o que faz o conjunto trancado ser o MESMO para toda transação que toque
 * esta stream: se cada uma pulasse o próprio alvo, duas réplicas em takeover
 * cruzado (A recuperando o claim de B enquanto B recupera o de A) adquiririam
 * conjuntos diferentes e poderiam fechar ciclo. A exclusão do alvo acontece só
 * no `WHERE` do UPDATE, onde ela não afeta locks.
 *
 * Com o índice de pé o conjunto tem no máximo UMA linha, então a ordem é
 * inócua; ela protege a janela em que o índice não existe (pré-migration,
 * pós-rollback, índice inválido) — ver o bloco em `claimNextEligibleTurn`.
 *
 * `MATERIALIZED` não é decoração: uma CTE inlinada pode ser replanejada, e o
 * `ORDER BY` — a única coisa que faz o lock ser determinístico — se perderia.
 *
 * Devolve os ids recuperados (vazio é o caso normal) para que o caller possa
 * auditar o desbloqueio. Nenhuma auditoria acontece AQUI: o repositório é
 * puro-DB, e `audit()` vive em `src/runtime/turns/lease.ts`.
 */
async function recoverExpiredStreamClaims(
  tx: Executor,
  args: { tenant_id: string; agent_id: string; turn_id: string },
): Promise<string[]> {
  const result = await tx.execute<{ id: string; previous_status: string }>(sql`
    WITH alvo AS MATERIALIZED (
      SELECT t.stream_key
        FROM ${agent_turns} t
       WHERE t.tenant_id = ${args.tenant_id}
         AND t.agent_id  = ${args.agent_id}
         AND t.id        = ${args.turn_id}
         AND t.stream_key IS NOT NULL
    ),
    ativos AS MATERIALIZED (
      SELECT t.id, t.status, t.lease_expires_at
        FROM ${agent_turns} t
        JOIN alvo ON t.stream_key = alvo.stream_key
       WHERE t.tenant_id = ${args.tenant_id}
         AND t.agent_id  = ${args.agent_id}
         AND t.status IN (${statusList(STREAM_OCCUPYING_STATUSES)})
       ORDER BY t.id
         FOR UPDATE OF t
    )
    UPDATE ${agent_turns} u
       SET status             = 'retryable',
           next_attempt_at    = now(),
           lease_expires_at   = now(),
           last_error_code    = 'stream_lease_expired',
           last_error_summary = 'claim expirado recuperado na transacao de claim da stream (#625)',
           state_version      = u.state_version + 1,
           updated_at         = now()
      FROM ativos
     WHERE u.id        = ativos.id
       AND u.tenant_id = ${args.tenant_id}
       AND u.agent_id  = ${args.agent_id}
       AND u.id       <> ${args.turn_id}
       AND ativos.lease_expires_at IS NOT NULL
       AND ativos.lease_expires_at <= now()
    RETURNING u.id, ativos.status AS previous_status
  `);
  const rows = Array.from(
    result.rows as unknown as Array<{ id: string; previous_status: string }>,
  );
  for (const row of rows) {
    incCounter('maia_turn_stream_claim_recovered_total', { from: row.previous_status });
  }
  return rows.map((row) => row.id);
}

/**
 * #626 — o head-of-line está LIGADO?
 *
 * Lido a cada claim (o memo é de `contractEnv`, não daqui) porque um kill
 * switch que só vale no boot não é kill switch: o rollback da fatia é
 * `FEATURE_TURN_HEAD_OF_LINE=false` + restart, e ler no import faria o valor
 * congelar num módulo que o console também carrega.
 */
function headOfLineEnabled(): boolean {
  return contractEnv.FEATURE_TURN_HEAD_OF_LINE;
}

/** O escopo corrente como FRAGMENTOS, que é o que `stream-head-sql` consome. */
function escopoSql(tenant_id: string, agent_id: string): { tenant: SQL; agent: SQL; alvo: SQL } {
  return { tenant: sql`${tenant_id}`, agent: sql`${agent_id}`, alvo: sql`${agent_turns}` };
}

/**
 * #625 + #626 — o corpo transacional de `claimNextEligibleTurn`: recuperar,
 * depois reivindicar o HEAD-OF-LINE.
 *
 * Vive fora do objeto do repositório porque precisa receber o `tx` — e porque a
 * ordem dos dois passos é o contrato inteiro da fatia B. Invertê-los (claim
 * primeiro, recuperação depois) reproduziria exatamente o defeito: o claim
 * bateria no índice ocupado por um dono morto e a stream nunca destravaria.
 *
 * ─── O que a fatia C muda aqui, e o que ela NÃO muda ──────────────────────
 *
 * Muda uma linha do `WHERE` — `streamHeadOfLineNotExists(...)` — e acrescenta o
 * canário no `RETURNING`. Não muda a recuperação, e a interação entre as duas
 * merece ser dita em voz alta porque ela INVERTE quem se beneficia:
 *
 *   ANTES (#625): o head morre com a lease vencida; o SUCESSOR reivindica, a
 *     transação recupera o morto (⇒ `retryable`) e o sucessor ENTRA. A conversa
 *     avança na hora, fora de ordem.
 *   DEPOIS (#626): a mesma transação recupera o morto — e então recusa o
 *     sucessor com `not_head`, porque `retryable` não é terminal. Quem avança é
 *     o MORTO, na sua vez, quando alguém o reivindicar de novo.
 *
 * A recuperação continua valendo a pena, e é por isso que ela roda mesmo no
 * caminho que vai fracassar: sem ela o morto ficaria `claimed` para sempre e a
 * stream nunca destravaria, nem para ele. O custo é latência — a conversa espera
 * até o recovery rearmar o morto (`STUCK_AFTER_MS`) em vez de o sucessor entrar
 * na hora. Fechar essa janela é promoção de sucessor, que é a fatia #627.
 */
async function claimWithinStreamExclusion(
  tx: Executor,
  input: { turn_id: string; worker_id: string; lease_ms: number },
): Promise<ClaimResult> {
  const { tenant_id, agent_id } = scope();
  const leaseSeconds = input.lease_ms / 1000;
  const escopo = escopoSql(tenant_id, agent_id);
  const fifo = headOfLineEnabled();

  const recovered = await recoverExpiredStreamClaims(tx, {
    tenant_id,
    agent_id,
    turn_id: input.turn_id,
  });
  // Presente só quando houve o que recuperar: um campo vazio em todo resultado
  // convidaria o caller a tratar `[]` como evento, e o normal é NÃO haver
  // claim expirado nenhum.
  const trail = recovered.length > 0 ? { recovered_stream_claims: recovered } : {};

  // A CONDIÇÃO DE HEAD-OF-LINE. Uma linha, e é a fatia inteira.
  //
  // `sql`TRUE`` com a flag desligada, e não um `if` em volta do statement: o
  // claim precisa ser UMA declaração atômica (ver o bloco de `claimNextEligibleTurn`
  // sobre EvalPlanQual), então os dois regimes têm de ser o MESMO SQL com um
  // predicado a mais. Montar duas queries diferentes é como se perde a
  // equivalência entre o caminho testado e o caminho de rollback.
  const condicaoHead = fifo ? streamHeadOfLineNotExists(escopo) : sql`TRUE`;
  // O CANÁRIO de `maia_stream_fifo_violation_total{stage="claim"}`: quantos
  // anteriores não terminais existiam DEPOIS de o claim ter sido concedido.
  // Zero é a resposta única. Só é computado quando a regra está ligada — com a
  // flag off ele seria legitimamente > 0 e o alarme viraria ruído.
  const canario = fifo ? earlierLiveTurnCount(escopo) : sql`0`;

  const result = await tx.execute<ClaimRow & { fifo_anteriores: number | string }>(sql`
    UPDATE ${agent_turns}
       SET status            = 'claimed',
           claimed_by        = ${input.worker_id},
           claim_token       = gen_random_uuid(),
           claimed_at        = now(),
           heartbeat_at      = now(),
           lease_expires_at  = now() + make_interval(secs => ${leaseSeconds}),
           attempt_count     = attempt_count + 1,
           state_version     = state_version + 1,
           next_attempt_at   = NULL,
           updated_at        = now()
     WHERE tenant_id = ${tenant_id}
       AND agent_id  = ${agent_id}
       AND id        = ${input.turn_id}
       AND (
             (status IN (${statusList(CLAIMABLE_STATUSES)})
               AND (status <> 'retryable' OR next_attempt_at IS NULL OR next_attempt_at <= now()))
          OR (status IN (${statusList(LEASE_TAKEOVER_STATUSES)})
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= now())
       )
       AND ${condicaoHead}
    RETURNING id, tenant_id, agent_id, status, attempt_count, claim_token,
              claimed_by, claimed_at, lease_expires_at, state_version,
              ${canario} AS fifo_anteriores
  `);
  const row = (result.rows as unknown as Array<ClaimRow & { fifo_anteriores: number | string }>)[0];
  if (!row) return await explainClaimRejection(tx, { tenant_id, agent_id, fifo, ...input }, trail);

  // PÓS-CONDIÇÃO. `> 0` significa que o claim passou por cima de um turno
  // anterior vivo — a inversão de ordem que a #505 existe para impedir, e um
  // dos critérios de ABORTAR o rollout na issue-mãe. Não desfazemos o claim: a
  // tentativa já é autorizada e desfazê-la aqui deixaria a stream sem ninguém.
  // O que se faz é MEDIR aqui e RELATAR em `src/runtime/turns/lease.ts` — o
  // repositório continua puro-DB, e `audit()` nele fecharia o ciclo de import
  // governance/audit -> repositories.
  const anteriores = Number(row.fifo_anteriores);
  if (anteriores > 0) recordStreamFifoViolation('claim');

  incCounter('maia_turn_claim_total', { result: 'acquired' });
  return {
    ok: true,
    ...(anteriores > 0
      ? { fifo_violation: { stage: 'claim' as const, earlier_live: anteriores } }
      : {}),
    claim: {
      turn_id: row.id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      attempt: Number(row.attempt_count),
      claim_token: row.claim_token,
      worker_id: row.claimed_by,
      claimed_at: new Date(row.claimed_at),
      lease_expires_at: new Date(row.lease_expires_at),
      status: row.status as TurnStatus,
      state_version: Number(row.state_version),
    },
    ...trail,
  };
}

/**
 * POR QUE o claim não foi concedido — a leitura ESCOPADA do caminho de
 * fracasso.
 *
 * Custa consultas, e por isso só roda quando já se sabe que o claim falhou.
 * Distinguir os motivos não é luxo de log: `not_found` é bug de roteamento,
 * `not_eligible` é corrida normal, `not_head` é fila da conversa e
 * `stream_blocked` é o outbox travado. Colapsá-los daria um único número que
 * sobe por quatro causas com quatro remediações diferentes — e, na prática,
 * ninguém investiga um número assim.
 *
 * A ORDEM importa: `not_head`/`stream_blocked` são verificados ANTES de
 * `not_eligible`. Um turno que é ao mesmo tempo não-head e não-elegível
 * (`retryable` com backoff em aberto, atrás de um anterior vivo) é reportado
 * como não-head, porque é a stream que decide primeiro — o backoff dele nem
 * chega a importar enquanto houver alguém na frente.
 */
async function explainClaimRejection(
  tx: Executor,
  args: { tenant_id: string; agent_id: string; turn_id: string; fifo: boolean },
  trail: { recovered_stream_claims?: readonly string[] },
): Promise<ClaimResult> {
  const escopo = escopoSql(args.tenant_id, args.agent_id);
  const alvo = await tx
    .select({ id: agent_turns.id, status: agent_turns.status })
    .from(agent_turns)
    .where(
      and(
        eq(agent_turns.tenant_id, args.tenant_id),
        eq(agent_turns.agent_id, args.agent_id),
        eq(agent_turns.id, args.turn_id),
      ),
    )
    .limit(1);
  const encontrado = alvo[0];
  if (!encontrado) {
    incCounter('maia_turn_claim_total', { result: 'not_found' });
    return { ok: false, reason: 'not_found', ...trail };
  }

  // Um turno TERMINAL nunca é `not_head`, ainda que a conversa tenha fila: a
  // fila dele acabou. Dizer "não é o head" de um turno concluído mandaria o
  // operador procurar o bloqueador de um trabalho que já terminou — e o motivo
  // honesto (`not_eligible`, "este turno não pode ser reivindicado") é o que
  // descreve o que de fato aconteceu.
  if (args.fifo && !isTerminalTurnStatus(encontrado.status as TurnStatus)) {
    const bloqueio = await tx.execute<{ id: string; status: string }>(
      earlierLiveTurnProbe({ tenant: escopo.tenant, agent: escopo.agent, turn_id: args.turn_id }),
    );
    const head = (bloqueio.rows as unknown as Array<{ id: string; status: string }>)[0];
    if (head) {
      // `outbound_pending` é a única situação em que NENHUM claim destrava a
      // stream: quem tira um turno dali é o delivery worker do outbox (#506).
      // A leitura operacional de `not_head` é "espere"; a de `stream_blocked`
      // é "vá ao runbook do outbox". Dar o mesmo código às duas mandaria o
      // operador esperar por algo que não vai acontecer.
      const reason: ClaimRejection =
        head.status === 'outbound_pending' ? 'stream_blocked' : 'not_head';
      incCounter('maia_turn_claim_total', { result: reason });
      recordStreamBlocked(reason);
      return {
        ok: false,
        reason,
        head_block: { turn_id: head.id, status: head.status as TurnStatus },
        ...trail,
      };
    }
  }

  incCounter('maia_turn_claim_total', { result: 'not_eligible' });
  return { ok: false, reason: 'not_eligible', ...trail };
}

/**
 * #505 — aloca a PRÓXIMA sequência de ingresso da stream, dentro da transação
 * do chamador.
 *
 * ─── Por que uma única declaração, e não read-modify-write ────────────────
 *
 * `SELECT max(ingress_seq)+1` seguido de `INSERT` é a forma intuitiva e está
 * errada: dois produtores leem o mesmo máximo e alocam o mesmo número. Corrigir
 * isso exigiria `SERIALIZABLE` (com o retry que ninguém escreve) ou um lock
 * explícito sobre uma linha que talvez ainda não exista.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` resolve os dois casos numa
 * declaração ATÔMICA:
 *   - stream nova  -> a linha nasce com `last_ingress_seq = 1`;
 *   - stream viva  -> o `DO UPDATE` incrementa sob o lock de linha, que o
 *     Postgres já segura para fazer o próprio `ON CONFLICT`.
 *
 * Um segundo produtor na MESMA stream bloqueia no lock até esta transação
 * terminar. Se ela COMITAR, ele lê o valor novo e soma 1 — monotônico, sem
 * buraco. Se ela ABORTAR, ele lê o valor antigo e soma 1 — o número volta,
 * que é exatamente o que faz uma reentrega não queimar sequência.
 *
 * Produtores em streams DIFERENTES não se encontram: linhas distintas, locks
 * distintos. É isto que dá o paralelismo entre conversas que a issue exige sem
 * nenhum lock global por tenant, agente ou fila.
 *
 * ─── Por que o WHERE do UPDATE repete tenant e agent ──────────────────────
 *
 * O `ON CONFLICT (tenant_id, agent_id, stream_key)` já garante que a linha
 * atingida é a do escopo — mas o predicado adicional torna a invariante
 * LEGÍVEL no lugar em que ela é aplicada, e sobrevive a uma futura mudança de
 * índice de conflito. Custo zero: as colunas estão na PK.
 */
async function allocateIngressSeq(
  tx: Executor,
  stream: { stream_key: string; stream_key_version: number },
): Promise<number> {
  const { tenant_id, agent_id } = scope();
  const result = await tx.execute<{ last_ingress_seq: string | number }>(sql`
    INSERT INTO ${agent_stream_sequences}
      (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
    VALUES (${tenant_id}, ${agent_id}, ${stream.stream_key}, ${stream.stream_key_version}, 1)
    ON CONFLICT (tenant_id, agent_id, stream_key) DO UPDATE
      SET last_ingress_seq = ${agent_stream_sequences}.last_ingress_seq + 1,
          updated_at = now()
      WHERE ${agent_stream_sequences}.tenant_id = ${tenant_id}
        AND ${agent_stream_sequences}.agent_id = ${agent_id}
    RETURNING last_ingress_seq
  `);
  const rows = Array.from(result.rows as unknown as Array<{ last_ingress_seq: string | number }>);
  const raw = rows[0]?.last_ingress_seq;
  const seq = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 1) {
    // Inalcançável pelo caminho normal: o `RETURNING` de um UPSERT sempre
    // devolve uma linha. Falha ALTO em vez de devolver um número inventado —
    // uma sequência errada aqui é reordenação silenciosa lá na frente.
    throw new Error(
      `allocateIngressSeq: alocação de ingress_seq não devolveu sequência utilizável ` +
        `(stream_key_version=${stream.stream_key_version})`,
    );
  }
  return seq;
}

async function createTurnForMessage(
  tx: Executor,
  args: {
    mensagem: Pick<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'conversa_id' | 'channel_id'>;
    deadline_at: Date | null;
    /**
     * #505 — a stream e a posição do ingresso representativo. Ausente para
     * turnos criados fora do protocolo (backfill, rede de compatibilidade de
     * uma row anterior à migration 118): nesses casos as colunas nascem NULL,
     * que é a verdade — "este turno não tem ordem canônica" —, e nunca um zero
     * ou uma stream inventada.
     */
    stream?: {
      stream_key: string;
      stream_key_version: number;
      ingress_seq: number;
    } | null;
  },
): Promise<AgentTurn> {
  const { mensagem } = args;
  const stream = args.stream ?? null;
  const guarded = applyTenantGuard({
    conversa_id: mensagem.conversa_id ?? null,
    channel_id: mensagem.channel_id ?? null,
    representative_message_id: mensagem.id,
    status: 'received' as const,
    deadline_at: args.deadline_at,
    // Turno SIMPLES: as duas fronteiras são o mesmo ingresso (§Relação entre
    // ingressos e turnos: "Para turno simples: first_ingress_seq =
    // last_ingress_seq"). A absorção do debounce estende `last` — nunca `first`.
    stream_key: stream?.stream_key ?? null,
    stream_key_version: stream?.stream_key_version ?? null,
    first_ingress_seq: stream?.ingress_seq ?? null,
    last_ingress_seq: stream?.ingress_seq ?? null,
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
 * O absorvedor AINDA é dono? Releitura de classificação, feita só quando a
 * absorção voltou zero linhas.
 *
 * Deliberadamente a MESMA condição de `absorberFenceCondition` — escopo,
 * token, lease viva e estado gravável — porque a pergunta é literalmente "o
 * predicado que reprovou foi este?". `lease_live` é avaliada NO BANCO pelo
 * mesmo motivo de sempre: comparar `lease_expires_at` com o relógio do
 * processo reintroduziria o clock skew que o fence existe para eliminar.
 */
async function absorberStillOwns(
  tx: Executor,
  args: {
    tenant_id: string;
    agent_id: string;
    absorber_turn_id: string;
    claim_token: string;
  },
): Promise<boolean> {
  const rows = await tx
    .select({ id: agent_turns.id })
    .from(agent_turns)
    .where(
      and(
        eq(agent_turns.tenant_id, args.tenant_id),
        eq(agent_turns.agent_id, args.agent_id),
        eq(agent_turns.id, args.absorber_turn_id),
        eq(agent_turns.claim_token, args.claim_token),
        inArray(agent_turns.status, [...FENCED_WRITE_STATUSES]),
        sql`${agent_turns.lease_expires_at} > now()`,
      ),
    )
    .limit(1);
  return rows.length === 1;
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
  absorber_fence?: { turn_id: string; claim_token: string };
  patch: TurnTransitionPatch;
}): Promise<TurnTransitionResult> {
  // O fence desta gravação, numa forma só. `turnWriteConditions` é a fonte
  // ÚNICA do `WHERE` — nada é acrescentado a ele depois desta chamada, e é o
  // que permite a `tests/unit/db/turn-fence-sql.spec.ts` compilar o predicado
  // REAL de produção sem Postgres.
  const fence: TurnWriteFence =
    args.absorber_fence !== undefined
      ? {
          kind: 'absorber',
          absorber_turn_id: args.absorber_fence.turn_id,
          claim_token: args.absorber_fence.claim_token,
        }
      : args.expected_claim_token !== undefined
        ? { kind: 'self', claim_token: args.expected_claim_token }
        : { kind: 'none' };

  try {
    return await runTransitionTx(args, fence);
  } catch (err) {
    // NARROW: só o índice de exclusão por stream. Ver o comentário do tipo
    // `TurnTransitionResult` e o de `claimNextEligibleTurn`.
    if (
      pgErrorCode(err) === PG_UNIQUE_VIOLATION &&
      pgErrorConstraint(err) === STREAM_EXCLUSION_CONSTRAINT
    ) {
      incCounter('maia_turn_transitions_total', {
        from: 'any',
        to: args.to,
        outcome: 'stream_busy',
      });
      return { ok: false, conflict: 'stream_busy', to: args.to };
    }
    throw err;
  }
}

async function runTransitionTx(
  args: {
    turn_id: string;
    to: TurnStatus;
    outcome: TurnOutcome | null;
    sources: readonly TurnStatus[];
    expected_version?: number;
    expected_claim_token?: string;
    absorber_fence?: { turn_id: string; claim_token: string };
    patch: TurnTransitionPatch;
  },
  fence: TurnWriteFence,
): Promise<TurnTransitionResult> {
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
    if (args.patch.clearClaim) {
      // #504 — a posse morre com a tentativa. `claimed_by` fica para a forense.
      set['claim_token'] = null;
      set['lease_expires_at'] = null;
    }

    const updated = await tx
      .update(agent_turns)
      .set(set as never)
      .where(
        and(
          ...turnWriteConditions({
            tenant_id,
            agent_id,
            turn_id: args.turn_id,
            sources: args.sources,
            ...(args.expected_version !== undefined
              ? { expected_version: args.expected_version }
              : {}),
            fence,
          }),
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
          // Avaliado NO BANCO: comparar `lease_expires_at` com o relógio do
          // processo aqui reintroduziria justamente o clock skew que o fence
          // existe para eliminar.
          lease_live: sql<boolean>`(${agent_turns.lease_expires_at} > now())`,
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
      // Classificação do conflito. A ordem importa: quando havia fence e ele
      // não bate, a causa é a PERDA DE POSSE — mesmo que o status também tenha
      // andado. Reportar `state_mismatch` aqui faria o caller reler e tentar de
      // novo, que é a reação exatamente errada para um zumbi.
      //
      // Com fence de ABSORVEDOR a pergunta é a mesma, feita na OUTRA linha:
      // "o turno que mandou absorver ainda tem a posse?". Um `state_mismatch`
      // aqui mandaria o absorvedor reler o irmão e reinsistir — e insistir é
      // exatamente o que um zumbi não pode fazer. Custa uma leitura escapada,
      // só no caminho de fracasso.
      const selfFenceBroken =
        args.expected_claim_token !== undefined &&
        (row.claim_token !== args.expected_claim_token || row.lease_live !== true);
      const absorberFenceBroken =
        args.absorber_fence !== undefined &&
        !(await absorberStillOwns(tx, {
          tenant_id,
          agent_id,
          absorber_turn_id: args.absorber_fence.turn_id,
          claim_token: args.absorber_fence.claim_token,
        }));
      const fenceBroken = selfFenceBroken || absorberFenceBroken;
      if (fenceBroken) {
        // NÃO incrementa `maia_turn_fence_rejected_total` aqui, e isso é uma
        // escolha de DONO, não um esquecimento.
        //
        // Uma escrita recusada tem de valer UM incremento. Enquanto esta linha
        // existia junto com `reportFenceRejection()` (src/runtime/turns/lease.ts),
        // uma única recusa somava dois — com labels diferentes (`to_completed` vs
        // `conclude_reply_delivered`), então qualquer agregação por `sum()` (que
        // é como um SLO e um alerta leem um counter) via o dobro das rejeições
        // reais.
        //
        // O dono do contador é a camada de runtime, por três razões:
        //   1. é a única que emite os TRÊS fatos juntos (métrica + log
        //      estruturado + auditoria `turn_fence_rejected`), então "uma
        //      recusa = uma linha em cada trilha" fica verificável num lugar só;
        //   2. o label dela é o `operation` do vocabulário da issue
        //      (`conclude_reply_delivered`, `fail_retryable`, `dead_letter`), e
        //      não o estado-alvo — que é o que um operador procura;
        //   3. existem recusas que NUNCA chegam aqui: quando a tentativa já sabe
        //      que a lease morreu, o guard em memória recusa sem ir ao banco
        //      (`refuseLostOwnership`). Se o dono do contador fosse este SELECT,
        //      essas ficariam invisíveis — justamente as mais graves.
        //
        // O repositório continua sendo a autoridade sobre a CLASSIFICAÇÃO
        // (`stale_claim` vs `state_mismatch`); ele só não conta.
        return {
          ok: false as const,
          conflict: 'stale_claim' as const,
          to: args.to,
          current_status: row.status as TurnStatus,
          current_state_version: Number(row.state_version),
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
