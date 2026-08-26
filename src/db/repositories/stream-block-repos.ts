/**
 * Issue #629 (fatia F da #505) — o repositório da STREAM BLOQUEADA.
 *
 * ─── Por que um arquivo próprio, e não mais 150 linhas em `turn-repos.ts` ──
 *
 * Duas razões, e a segunda é a que decide. A primeira é tamanho:
 * `turn-repos.ts` já passa de três mil linhas e a convenção do repositório
 * (AGENTS.md §5.3) trata isso como sinal de refatoração. A segunda é ESCOPO de
 * escrita: quem BLOQUEIA é a transação do CAS terminal, dentro de
 * `turn-repos.ts`, porque o bloqueio tem de ser atômico com o `dead_letter`.
 * Quem DESBLOQUEIA é uma operação de operador, sem transação compartilhada com
 * nada. Misturar as duas num arquivo faria parecer que o desbloqueio também
 * precisa da transação do turno — e a primeira pessoa a "consertar" isso
 * envolveria o `UPDATE` de desbloqueio num `withTx` que não protege nada.
 *
 * ─── O que este módulo NÃO faz ────────────────────────────────────────────
 *
 * Não decide nada, não audita e não fala com a fila. A decisão de bloquear é da
 * política (`src/runtime/turns/poison-policy.ts`); a de desbloquear é humana; a
 * auditoria e o re-arme moram em `src/ops/stream-unblock.ts`. Aqui só há SQL —
 * pelo mesmo motivo que `turn-repos.ts` não chama `audit()`: um repositório que
 * alcança `@/governance/audit.js` fecha o ciclo de import governance ->
 * repositories.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { agent_stream_blocks, agent_turns } from '../schema.js';
import type { AgentStreamBlock } from '../schema.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

/**
 * Uma conversa INTERDITADA, na forma que a operação precisa.
 *
 * `stream_key` NÃO sai daqui, e é deliberado: a issue-mãe a restringe a log
 * protegido, e nada na operação precisa dela — o desbloqueio é endereçado por
 * `block_id`, e "que conversa é essa?" se responde pelo turno envenenado.
 * Devolvê-la aqui a poria a um `console.log` de distância de virar saída de
 * CLI.
 */
export type ActiveStreamBlock = {
  block_id: string;
  tenant_id: string;
  agent_id: string;
  reason: string;
  category: string;
  blocked_by_turn_id: string;
  error_code: string | null;
  blocked_at: Date;
  /** Quantos turnos NÃO terminais estão presos atrás desta interdição. */
  backlog: number;
};

/** Resultado TIPADO do desbloqueio. Conflito nunca é sucesso silencioso. */
export type StreamUnblockResult =
  | {
      ok: true;
      block: AgentStreamBlock;
      /**
       * O turno que deve voltar a andar quando a conversa é liberada: o menor
       * `first_ingress_seq` NÃO terminal da stream. `null` quando não há
       * nenhum — a conversa foi liberada e não tem trabalho pendente, que é o
       * caso normal quando o único turno da fila era o próprio envenenado.
       */
      head: { turn_id: string; representative_message_id: string; conversa_id: string | null } | null;
    }
  /** Não existe bloqueio ATIVO com este id NO ESCOPO corrente. */
  | { ok: false; conflict: 'not_blocked' };

export const streamBlocksRepo = {
  /**
   * Enumeração CROSS-TENANT das conversas interditadas AGORA.
   *
   * Roda FORA de contexto de tenant, como o dispatcher do recovery (#345): a
   * pergunta do plantão é "o que está parado na plataforma?", e ela não tem
   * tenant. A forma sancionada é a mesma — o escopo sai das COLUNAS e volta no
   * resultado, e o que sai da consulta é ids e contagens, nunca conteúdo.
   *
   * O `backlog` vem por subconsulta correlacionada e é o número que decide a
   * prioridade: uma interdição com 40 turnos presos atrás dela é um incidente
   * de usuário; uma com zero é um item de faxina.
   */
  async listActiveCrossTenant(limit = 100): Promise<ActiveStreamBlock[]> {
    const result = await db.execute<{
      id: string;
      tenant_id: string;
      agent_id: string;
      reason: string;
      category: string;
      blocked_by_turn_id: string;
      error_code: string | null;
      blocked_at: string;
      backlog: string;
    }>(sql`
      SELECT b.id, b.tenant_id, b.agent_id, b.reason, b.category,
             b.blocked_by_turn_id, b.error_code, b.blocked_at,
             (SELECT count(*)::int
                FROM ${agent_turns} AS t
               WHERE t.tenant_id  = b.tenant_id
                 AND t.agent_id   = b.agent_id
                 AND t.stream_key = b.stream_key
                 AND t.status NOT IN ('completed','ignored','superseded','dead_letter')
             ) AS backlog
        FROM ${agent_stream_blocks} AS b
       WHERE b.unblocked_at IS NULL
       ORDER BY b.blocked_at ASC
       LIMIT ${limit}
    `);
    return Array.from(
      result.rows as unknown as Array<{
        id: string;
        tenant_id: string;
        agent_id: string;
        reason: string;
        category: string;
        blocked_by_turn_id: string;
        error_code: string | null;
        blocked_at: string;
        backlog: string;
      }>,
    ).map((r) => ({
      block_id: r.id,
      tenant_id: r.tenant_id,
      agent_id: r.agent_id,
      reason: r.reason,
      category: r.category,
      blocked_by_turn_id: r.blocked_by_turn_id,
      error_code: r.error_code,
      blocked_at: new Date(r.blocked_at),
      backlog: Number(r.backlog),
    }));
  },

  /** O bloqueio ATIVO desta conversa, se houver. Escopado pelo ALS. */
  async findActiveByTurn(turn_id: string): Promise<AgentStreamBlock | null> {
    const { tenant_id, agent_id } = scope();
    const rows = await db
      .select({ b: agent_stream_blocks })
      .from(agent_stream_blocks)
      .innerJoin(
        agent_turns,
        and(
          eq(agent_turns.tenant_id, agent_stream_blocks.tenant_id),
          eq(agent_turns.agent_id, agent_stream_blocks.agent_id),
          eq(agent_turns.stream_key, agent_stream_blocks.stream_key),
        ),
      )
      .where(
        and(
          eq(agent_stream_blocks.tenant_id, tenant_id),
          eq(agent_stream_blocks.agent_id, agent_id),
          isNull(agent_stream_blocks.unblocked_at),
          eq(agent_turns.id, turn_id),
        ),
      )
      .orderBy(desc(agent_stream_blocks.blocked_at))
      .limit(1);
    return rows[0]?.b ?? null;
  },

  /**
   * DESBLOQUEIA a conversa e devolve o head que precisa de wake-up.
   *
   * ─── Por que é um CAS, e não um `UPDATE` cego ────────────────────────────
   *
   * `unblocked_at IS NULL` no `WHERE` faz duas coisas ao mesmo tempo. A óbvia:
   * dois operadores desbloqueando a mesma conversa produzem um desbloqueio e um
   * `not_blocked` — e o segundo NÃO audita, então a `audit_log` não ganha duas
   * decisões humanas onde houve uma. A menos óbvia: um `UPDATE` cego
   * reescreveria `unblocked_by`/`unblock_reason` de um desbloqueio ANTIGO,
   * apagando quem realmente destravou aquela conversa da última vez. O
   * histórico existe para responder "quem liberou isto, e por quê" — e é
   * exatamente o campo que um update sem guarda destrói.
   *
   * ─── Por que o head sai daqui, e na MESMA transação ─────────────────────
   *
   * Pela mesma razão de `promoteStreamSuccessor` (#627): quem desbloqueia deve
   * um wake-up à conversa, e para armar o job é preciso o
   * `representative_message_id`, que só existe na linha do head. Buscá-lo numa
   * segunda consulta abriria a janela em que a fila muda entre as duas leituras
   * e o sinal descreveria um estado que já não existe.
   *
   * O que este método NÃO faz é `promoted_at = now()`: a promoção é uma
   * ELEIÇÃO entre candidatos, e aqui não há eleição — a conversa simplesmente
   * voltou a ser elegível, e o head volta a ser reivindicável pelo caminho de
   * sempre. Carimbar `promoted_at` faria o varredor contar uma reconciliação
   * (`maia_stream_promotion_total{result="recovered"}`) para cada desbloqueio,
   * e essa série existe para medir sinal PERDIDO, não trabalho de operador.
   */
  async unblockTx(input: {
    block_id: string;
    actor: string;
    reason: string;
  }): Promise<StreamUnblockResult> {
    const { tenant_id, agent_id } = scope();
    const updated = await db
      .update(agent_stream_blocks)
      .set({
        unblocked_at: sql`now()`,
        unblocked_by: input.actor,
        unblock_reason: input.reason,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(agent_stream_blocks.tenant_id, tenant_id),
          eq(agent_stream_blocks.agent_id, agent_id),
          eq(agent_stream_blocks.id, input.block_id),
          isNull(agent_stream_blocks.unblocked_at),
        ),
      )
      .returning();
    const block = updated[0];
    if (!block) return { ok: false, conflict: 'not_blocked' };

    const head = await db
      .select({
        id: agent_turns.id,
        representative_message_id: agent_turns.representative_message_id,
        conversa_id: agent_turns.conversa_id,
      })
      .from(agent_turns)
      .where(
        and(
          eq(agent_turns.tenant_id, tenant_id),
          eq(agent_turns.agent_id, agent_id),
          eq(agent_turns.stream_key, block.stream_key),
          sql`${agent_turns.status} NOT IN ('completed','ignored','superseded','dead_letter')`,
          sql`${agent_turns.first_ingress_seq} IS NOT NULL`,
        ),
      )
      .orderBy(agent_turns.first_ingress_seq)
      .limit(1);
    const row = head[0];
    return {
      ok: true,
      block,
      head: row
        ? {
            turn_id: row.id,
            representative_message_id: row.representative_message_id,
            conversa_id: row.conversa_id,
          }
        : null,
    };
  },
};
