/**
 * Issue #633 (fatia D da épica #506) — as declarações SQL da RECUPERAÇÃO.
 *
 * `outbound-outbox-repo.ts` (#631) cria a linha; `outbound-delivery-repo.ts`
 * (#632) a entrega sob claim/lease/fence; este módulo é quem olha para o que
 * ficou para trás.
 *
 * ─── A forma das declarações, e por que ela é a garantia ────────────────────
 *
 * Toda MUTAÇÃO abaixo é UM `UPDATE ... WHERE <estado esperado> ... RETURNING`,
 * com o estado de origem no `WHERE` (CAS). Nenhuma é "SELECT, decide, UPDATE"
 * sobre o estado lido — sob READ COMMITTED dois sweepers concorrentes leem o
 * mesmo estado elegível e os dois escrevem, e é exatamente essa a duplicata que
 * o critério de pronto nº 1 proíbe.
 *
 * As LEITURAS de varredura (as `list*`) não precisam disso: elas produzem
 * candidatos, e quem decide é a mutação subsequente. Um candidato lido por dois
 * sweepers vira, no máximo, dois `UPDATE` dos quais um volta zero linhas.
 *
 * Todo relógio é o do PostgreSQL (`now()`), nunca `Date.now()`: elegibilidade
 * por lease e por idade compara instantes entre máquinas, e um nó adiantado
 * tomaria leases vivas — takeover falso, que neste domínio significa duplo
 * envio.
 *
 * ─── Por que NÃO entra no barril `src/db/repositories.ts` ───────────────────
 *
 * Mesma razão dos dois irmãos: este módulo importa `auditTx`
 * (`@/governance/audit.js`), que importa `auditRepo` de `@/db/repositories.js`.
 * Reexportar daqui fecharia o ciclo. Os consumidores importam por caminho
 * direto.
 */
import { sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { agent_turns, mensagens, outbound_messages } from '../schema.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import { auditTx } from '@/governance/audit.js';
import { statusList } from './turn-fence-sql.js';
import {
  DELIVERY_CLAIMABLE_STATUSES,
  DELIVERY_TAKEOVER_STATUSES,
} from '@/runtime/outbound/delivery-contract.js';
import {
  MANUAL_REARM_SOURCE_STATUSES,
  type OutboundDeadLetterReason,
} from '@/runtime/outbound/recovery-contract.js';
import { TERMINAL_TURN_STATUSES } from '@/runtime/turns/contract.js';
import type { OutboundDeliveryOutcome, OutboundPayloadType } from '@/runtime/outbound/contract.js';

/**
 * Um par (tenant, agent) com trabalho de recuperação. O dispatcher enumera
 * isto FORA de contexto de tenant e abre um contexto por tupla — mesmo padrão
 * de `outbound-messages-sweeper.ts` (#292) e de `reflection-batch` (#240/#251).
 */
export type RecoveryScope = { tenant_id: string; agent_id: string };

/** Um candidato da varredura. Só o que a decisão precisa — nunca o payload. */
export type RecoveryCandidate = {
  outbound_id: string;
  status: string;
  attempt: number;
  payload_type: OutboundPayloadType;
  delivery_outcome: OutboundDeliveryOutcome | null;
  /** Idade da linha em ms, calculada pelo relógio do BANCO. */
  age_ms: number;
};

/** Uma divergência turno↔outbound, já classificada. */
export type TurnOutboundDivergence = {
  turn_pending_without_outbound: number;
  outbound_without_live_turn: number;
};

export const outboundRecoveryRepo = {
  /**
   * Os pares (tenant, agent) que têm QUALQUER trabalho de recuperação.
   *
   * Roda FORA de contexto de tenant — é o dispatcher. As três pernas do `OR`
   * são exatamente as três varreduras, e cada uma casa com um índice:
   *
   *   - `pending`/`retryable` vencidas   → `idx_outbound_messages_ready` (121);
   *   - claim com lease vencida          → `idx_outbound_messages_expired_claims` (131);
   *   - fila de reconciliação            → `idx_outbound_messages_reconcile` (131).
   *
   * `tenant_id IS NOT NULL` é redundante com o schema (NOT NULL desde a 063) e
   * fica pelo mesmo motivo do #251: protege contra uma futura relaxação do
   * schema em vez de contra um bug de hoje.
   */
  async listScopesWithWork(): Promise<RecoveryScope[]> {
    const result = await db.execute<RecoveryScope>(scopesWithWorkStatement());
    return Array.from(result.rows as unknown as RecoveryScope[]);
  },

  /**
   * As linhas ENTREGÁVEIS do escopo corrente: `pending`/`retryable` com o gate
   * de backoff vencido, MAIS `claimed`/`sending` com lease morta.
   *
   * As duas famílias saem juntas de propósito. O consumidor faz a MESMA coisa
   * com as duas — rearmar o job determinístico — e a diferença entre "nunca
   * teve dono" e "o dono morreu" é resolvida DENTRO do claim atômico
   * (`tryClaimDelivery`) e da `claimDisposition`, que é onde ela precisa ser
   * resolvida: uma linha tomada em `sending` NÃO é reenviada, ela vira
   * `delivery_unknown`. Separar aqui só criaria um segundo lugar onde essa
   * distinção pode ser escrita errado.
   *
   * `ORDER BY created_at ASC` + `LIMIT` — justiça por escopo, mais antiga
   * primeiro. Um tenant de alto volume não consome a janela inteira.
   */
  async listDeliverable(limit: number): Promise<RecoveryCandidate[]> {
    const result = await db.execute<RawCandidate>(
      deliverableStatement(getCurrentTenant(), getCurrentAgent(), limit),
    );
    return mapCandidates(result.rows);
  },

  /**
   * A fila de RECONCILIAÇÃO do escopo corrente — o produto principal da fatia.
   *
   * Três estados, três razões (ver o comentário do índice na migração 131):
   * `delivery_unknown` (entrega incerta), `reconciling` (triada, aguardando
   * humano — continua na fila porque envelhecer é o alarme) e `delivered`
   * (a janela `delivered -> completed` declarada pela #632).
   */
  async listReconciliation(limit: number): Promise<RecoveryCandidate[]> {
    const result = await db.execute<RawCandidate>(
      reconciliationStatement(getCurrentTenant(), getCurrentAgent(), limit),
    );
    return mapCandidates(result.rows);
  },

  /**
   * `delivery_unknown -> retryable`. A ÚNICA escrita desta fatia que autoriza
   * um efeito externo repetido.
   *
   * Ela existe porque a linha incerta NÃO é reivindicável (`delivery_unknown`
   * não está em `DELIVERY_CLAIMABLE_STATUSES` nem em
   * `DELIVERY_TAKEOVER_STATUSES`, e isso é deliberado em #632): para que o
   * worker volte a tocá-la, alguém precisa devolvê-la ao vocabulário de
   * trabalho. Quem pode pedir isso é `reconciliationDisposition`, e só quando
   * ela devolve `resend_idempotent` — que por sua vez só acontece quando
   * `autoResendAllowed` é verdadeiro.
   *
   * A guarda estrutural que sobra, e que NÃO depende de o chamador ter
   * perguntado certo: o CAS `status = 'delivery_unknown'`. Duas réplicas do
   * sweeper que decidam o mesmo produzem UM `UPDATE` vencedor e um que volta
   * zero linhas — critério de pronto nº 1, no lock de row do PostgreSQL e não
   * em disciplina de código.
   *
   * `next_attempt_at = now()` é obrigatório e não cosmético: o CHECK
   * `outbound_messages_durable_row_complete_check` (121) exige
   * `next_attempt_at IS NOT NULL`, e o índice de trabalho `idx_outbound_messages_ready`
   * só enxerga a linha quando o gate venceu.
   *
   * A POSSE não é adquirida aqui: a linha volta sem dono (`claim_token` já é
   * NULL, porque `recordDeliveryOutcome` a soltou ao gravar o desfecho
   * incerto). Quem a reivindica é o worker, pelo claim atômico.
   */
  async promoteUnknownToRetryable(input: {
    outbound_id: string;
  }): Promise<{ promoted: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute(sql`
      UPDATE ${outbound_messages}
         SET status          = 'retryable',
             next_attempt_at = now(),
             last_error_code = 'reconciled_idempotent_resend'
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND id        = ${input.outbound_id}::uuid
         AND status    = 'delivery_unknown'
      RETURNING id
    `);
    return { promoted: result.rows.length > 0 };
  },

  /**
   * `delivery_unknown -> reconciling`. A linha sai do automático e entra na
   * fila humana.
   *
   * NÃO é terminal e NÃO solta a linha do radar: `reconciling` continua no
   * índice de reconciliação (131) e continua alimentando
   * `maia_outbound_pending_age_seconds`. Um `reconciling` que envelhece é o
   * alarme — se ele saísse da fila, "escalado" viraria sinônimo de "esquecido".
   */
  async markReconciling(input: { outbound_id: string }): Promise<{ marked: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute(sql`
      UPDATE ${outbound_messages}
         SET status = 'reconciling'
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND id        = ${input.outbound_id}::uuid
         AND status    = 'delivery_unknown'
      RETURNING id
    `);
    return { marked: result.rows.length > 0 };
  },

  /**
   * `-> dead_letter`, AUDITADO, na mesma transação.
   *
   * A transição e a auditoria compartilham o `tx` pela razão de #631: a prova
   * durável de que a plataforma DESISTIU de uma resposta não pode viver fora da
   * transação que a produziu. Uma DLQ sem trilha é um silêncio que ninguém
   * consegue reconstruir.
   *
   * Os estados de origem são fechados e passados pelo chamador — `retryable` e
   * `pending` para o teto de tentativas, `delivery_unknown`/`reconciling` para
   * o prazo de reconciliação. O CAS por lista é o que torna a operação
   * idempotente entre sweepers concorrentes: o segundo volta zero linhas e não
   * grava auditoria duplicada.
   *
   * `claim_token`/`claimed_by`/`lease_expires_at` viram NULL: uma linha
   * terminal com dono faria a varredura de takeover esperar por um worker que
   * já foi embora. O CHECK `outbound_messages_claim_complete_check` (121) exige
   * o trio inteiro ou ausente, e é o ausente que se grava.
   */
  async deadLetterTx(input: {
    outbound_id: string;
    from_statuses: readonly string[];
    reason: OutboundDeadLetterReason;
    conversa_id: string;
    in_reply_to: string;
    attempt: number;
    delivery_outcome: OutboundDeliveryOutcome | null;
  }): Promise<{ dead_lettered: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const moved = await tx.execute(sql`
        UPDATE ${outbound_messages}
           SET status           = 'dead_letter',
               last_error_code  = ${input.reason},
               claimed_by       = NULL,
               claim_token      = NULL,
               lease_expires_at = NULL
         WHERE tenant_id = ${tenant_id}
           AND agent_id  = ${agent_id}
           AND id        = ${input.outbound_id}::uuid
           AND status    IN (${statusList(input.from_statuses)})
        RETURNING id
      `);
      if (moved.rows.length === 0) return { dead_lettered: false };
      await auditTx(tx, {
        acao: 'outbound_dead_lettered',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        metadata: {
          outbound_id: input.outbound_id,
          reason: input.reason,
          attempt: input.attempt,
          delivery_outcome: input.delivery_outcome,
        },
      });
      return { dead_lettered: true };
    });
  },

  /**
   * REARMAMENTO MANUAL: `dead_letter`/`reconciling`/`delivery_unknown` ->
   * `retryable`, AUDITADO, na mesma transação.
   *
   * É a operação da falha #12 da issue-mãe, e o que a torna segura NÃO está
   * aqui: está em `manualRearmRefusal` (recovery-contract.ts), que o chamador
   * (`src/ops/outbound-rearm.ts`) consulta ANTES. O que está aqui é a rede
   * estrutural — o CAS por lista fechada de origem — e a trilha.
   *
   * O `acknowledged_duplicate_risk` vai para a auditoria mesmo quando é
   * `false`: o que se quer reconstruir depois é "o operador foi avisado e
   * assumiu?", e a ausência do campo tornaria as duas situações idênticas na
   * trilha.
   */
  async rearmManuallyTx(input: {
    outbound_id: string;
    conversa_id: string;
    in_reply_to: string;
    actor: string;
    reason: string;
    from_status: string;
    duplicate_risk: boolean;
    acknowledged_duplicate_risk: boolean;
  }): Promise<{ rearmed: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const moved = await tx.execute(sql`
        UPDATE ${outbound_messages}
           SET status           = 'retryable',
               next_attempt_at  = now(),
               last_error_code  = 'manual_rearm',
               claimed_by       = NULL,
               claim_token      = NULL,
               lease_expires_at = NULL
         WHERE tenant_id = ${tenant_id}
           AND agent_id  = ${agent_id}
           AND id        = ${input.outbound_id}::uuid
           AND status    IN (${statusList(MANUAL_REARM_SOURCE_STATUSES)})
        RETURNING id
      `);
      if (moved.rows.length === 0) return { rearmed: false };
      await auditTx(tx, {
        acao: 'outbound_manual_rearm',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        metadata: {
          outbound_id: input.outbound_id,
          actor: input.actor,
          reason: input.reason,
          from_status: input.from_status,
          to_status: 'retryable',
          duplicate_risk: input.duplicate_risk,
          acknowledged_duplicate_risk: input.acknowledged_duplicate_risk,
        },
      });
      return { rearmed: true };
    });
  },

  /**
   * A linha `delivered` tem histórico?
   *
   * A janela `delivered -> completed` de #632 é fechada por transação, então
   * uma linha `delivered` NUNCA deveria ter histórico. Mas o caminho SÍNCRONO
   * de `output-dispatch.ts` grava o histórico por conta própria e para em
   * `delivered` — então a resposta aqui distingue "worker morreu entre as duas
   * escritas" de "o caminho síncrono fez o seu trabalho e o estado só não
   * avançou". Sem esta leitura, a reconciliação inseriria um segundo histórico
   * para uma resposta que já está na conversa.
   *
   * O predicado é `metadata->>'in_reply_to'`, o mesmo campo que
   * `buildHistorico` (#632) e o dispatcher síncrono gravam. Não há unique em
   * `mensagens` sobre isso (a unicidade da tabela é por `id`), e é justamente
   * por não haver que esta leitura precede a escrita.
   */
  async hasHistoryFor(input: {
    conversa_id: string;
    in_reply_to: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ n: string }>(sql`
      SELECT count(*) AS n
        FROM ${mensagens}
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND conversa_id = ${input.conversa_id}::uuid
         AND direcao     = 'out'
         AND metadata->>'in_reply_to' = ${input.in_reply_to}
    `);
    return Number((result.rows as unknown as Array<{ n: string }>)[0]?.n ?? 0) > 0;
  },

  /**
   * `delivered -> completed` quando o histórico JÁ existe.
   *
   * Fecha a janela declarada pela #632 sem tocar no provedor e sem inserir
   * nada: a mensagem chegou (o estado `delivered` só nasce de
   * `accepted_confirmed`) e o histórico está lá. O que faltava era o estado
   * dizer isso.
   *
   * NÃO é fenced pelo `claim_token`: o dono original morreu, e o token dele —
   * se ainda estiver na row — é justamente o que impede qualquer um de
   * concluir. O CAS `status = 'delivered'` é a serialização entre sweepers.
   */
  async completeDeliveredWithHistoryTx(input: {
    outbound_id: string;
    conversa_id: string;
    in_reply_to: string;
  }): Promise<{ completed: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const moved = await tx.execute(sql`
        UPDATE ${outbound_messages}
           SET status           = 'completed',
               claimed_by       = NULL,
               claim_token      = NULL,
               lease_expires_at = NULL
         WHERE tenant_id = ${tenant_id}
           AND agent_id  = ${agent_id}
           AND id        = ${input.outbound_id}::uuid
           AND status    = 'delivered'
        RETURNING id
      `);
      if (moved.rows.length === 0) return { completed: false };
      await auditTx(tx, {
        acao: 'outbound_delivery_completed',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        metadata: {
          outbound_id: input.outbound_id,
          from_status: 'delivered',
          to_status: 'completed',
          recovered_by: 'reconciliation',
        },
      });
      return { completed: true };
    });
  },

  /**
   * Idade, em segundos, da saída lógica NÃO ENTREGUE mais antiga do escopo.
   *
   * É a base de `maia_outbound_pending_age_seconds`, e a definição de "não
   * entregue" é a que interessa ao operador: tudo que não é `completed` e não é
   * terminal por decisão (`failed_terminal`, `cancelled`, `dead_letter`). Uma
   * `delivered` sem histórico CONTA — a mensagem chegou, mas o ciclo não
   * fechou, e é isso que a série mede.
   *
   * Zero quando não há nada pendente. Zero e "não medido" são o mesmo ponto
   * aqui de propósito: a série só existe por escopo com linha durável, e um
   * escopo sem outbox não tem idade a reportar.
   */
  async oldestPendingAgeSeconds(): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ age_seconds: string | null }>(sql`
      SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - created_at))), 0) AS age_seconds
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND turn_id IS NOT NULL
         AND status NOT IN (
           'completed', 'failed_terminal', 'cancelled', 'dead_letter',
           -- vocabulário legado da 063: uma row do caminho síncrono antigo não
           -- pertence a esta série (ela nunca teve turn_id, mas o predicado
           -- fica explícito para que a série não mude de significado se um dia
           -- alguém fizer backfill).
           'sent', 'failed', 'unknown'
         )
    `);
    const raw = (result.rows as unknown as Array<{ age_seconds: string | null }>)[0];
    return Math.max(0, Math.round(Number(raw?.age_seconds ?? 0)));
  },

  /**
   * A divergência turno↔outbound, nos DOIS sentidos, numa declaração só.
   *
   * Uma consulta e não duas porque as duas contagens têm de vir do MESMO
   * instante: rodadas separadas, uma linha que muda de estado entre elas
   * apareceria nas duas contagens ou em nenhuma, e a divergência reportada
   * seria um artefato da janela.
   *
   * Sentido 1 (`turn_pending_without_outbound`) — turno em `outbound_pending`
   *   sem NENHUMA linha do outbox. Casa com `agent_turns_live_status_idx`
   *   (parcial, inclui `outbound_pending`).
   * Sentido 2 (`outbound_without_live_turn`) — linha do outbox NÃO terminal
   *   cujo turno JÁ é terminal. Casa com `outbound_messages_turn_sequence_uq`
   *   pelo lado do outbox.
   *
   * `NOT EXISTS` e não `LEFT JOIN ... IS NULL`: o planejador transforma o
   * primeiro em anti-join sem materializar a linha ausente, e a intenção fica
   * legível — a pergunta é "existe?", não "junte e descarte".
   */
  async countTurnOutboundDivergence(): Promise<TurnOutboundDivergence> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ pending_sem_outbound: string; outbound_sem_turno: string }>(sql`
      SELECT
        (SELECT count(*)
           FROM ${agent_turns} t
          WHERE t.tenant_id = ${tenant_id}
            AND t.agent_id  = ${agent_id}
            AND t.status    = 'outbound_pending'
            AND NOT EXISTS (
              SELECT 1 FROM ${outbound_messages} o
               WHERE o.tenant_id = t.tenant_id
                 AND o.agent_id  = t.agent_id
                 AND o.turn_id   = t.id
            )
        ) AS pending_sem_outbound,
        (SELECT count(*)
           FROM ${outbound_messages} o
           JOIN ${agent_turns} t
             ON t.tenant_id = o.tenant_id
            AND t.agent_id  = o.agent_id
            AND t.id        = o.turn_id
          WHERE o.tenant_id = ${tenant_id}
            AND o.agent_id  = ${agent_id}
            AND o.turn_id IS NOT NULL
            AND o.status NOT IN (
              'completed', 'failed_terminal', 'cancelled', 'dead_letter',
              'sent', 'failed', 'unknown'
            )
            AND t.status IN (${statusList(TERMINAL_TURN_STATUSES)})
        ) AS outbound_sem_turno
    `);
    const row = (result.rows as unknown as Array<{
      pending_sem_outbound: string;
      outbound_sem_turno: string;
    }>)[0];
    return {
      turn_pending_without_outbound: Number(row?.pending_sem_outbound ?? 0),
      outbound_without_live_turn: Number(row?.outbound_sem_turno ?? 0),
    };
  },

  /**
   * A linha, por id, com o que a operação manual precisa mostrar ao operador
   * ANTES de ele confirmar. Escopada — uma linha de outro tenant é `null`.
   */
  async findForOperator(outbound_id: string): Promise<{
    outbound_id: string;
    status: string;
    attempt: number;
    payload_type: OutboundPayloadType;
    delivery_outcome: OutboundDeliveryOutcome | null;
    last_error_code: string | null;
    conversa_id: string;
    in_reply_to: string;
    created_at: Date;
  } | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{
      id: string;
      status: string;
      attempt: number;
      payload_type: string | null;
      delivery_outcome: string | null;
      last_error_code: string | null;
      conversa_id: string;
      in_reply_to: string;
      created_at: string;
    }>(sql`
      SELECT id, status, attempt, payload_type, delivery_outcome, last_error_code,
             conversa_id, in_reply_to, created_at
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND id        = ${outbound_id}::uuid
       LIMIT 1
    `);
    const row = (result.rows as unknown as Array<Record<string, never>>)[0] as
      | {
          id: string;
          status: string;
          attempt: number;
          payload_type: string | null;
          delivery_outcome: string | null;
          last_error_code: string | null;
          conversa_id: string;
          in_reply_to: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      outbound_id: row.id,
      status: row.status,
      attempt: Number(row.attempt),
      payload_type: (row.payload_type ?? 'text') as OutboundPayloadType,
      delivery_outcome: row.delivery_outcome as OutboundDeliveryOutcome | null,
      last_error_code: row.last_error_code,
      conversa_id: row.conversa_id,
      in_reply_to: row.in_reply_to,
      created_at: new Date(row.created_at),
    };
  },

  /**
   * Os dados de correlação da linha — o que a auditoria da DLQ precisa e o
   * candidato da varredura NÃO carrega.
   *
   * Separado de `listDeliverable`/`listReconciliation` de propósito: as
   * varreduras rodam a cada tick sobre até `limit` linhas, e `conversa_id`/
   * `in_reply_to` só interessam no caminho RARO em que algo de fato acontece.
   */
  async correlationOf(outbound_id: string): Promise<{
    conversa_id: string;
    in_reply_to: string;
  } | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ conversa_id: string; in_reply_to: string }>(sql`
      SELECT conversa_id, in_reply_to
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND id        = ${outbound_id}::uuid
       LIMIT 1
    `);
    return (
      (result.rows as unknown as Array<{ conversa_id: string; in_reply_to: string }>)[0] ?? null
    );
  },
};

// ---------------------------------------------------------------------------
// AS TRÊS VARREDURAS, COMO DECLARAÇÕES REUTILIZÁVEIS
//
// Cada uma existe como FUNÇÃO que devolve o `sql` — e não inline no método —
// por uma razão só, e é a mesma de `turn-fence-sql.ts` (#504): assim o TESTE
// consegue passar a declaração de PRODUÇÃO para o `EXPLAIN` em vez de
// reescrevê-la.
//
// A #632 pediu esta validação nominalmente: `idx_outbound_messages_ready` (121)
// é parcial em `pending`/`retryable` e NÃO cobre a varredura de takeover, então
// era preciso confirmar com EXPLAIN que ela não cai em Seq Scan. Um teste que
// montasse o SQL por conta própria continuaria verde depois de alguém trocar a
// ordem das colunas do `WHERE` de produção — mediria a si mesmo.
// ---------------------------------------------------------------------------

/** O dispatcher: que pares (tenant, agent) têm QUALQUER trabalho? */
export function scopesWithWorkStatement() {
  return sql`
      SELECT DISTINCT tenant_id, agent_id
        FROM ${outbound_messages}
       WHERE tenant_id IS NOT NULL
         AND agent_id  IS NOT NULL
         AND turn_id   IS NOT NULL
         AND (
               (status IN (${statusList(DELIVERY_CLAIMABLE_STATUSES)})
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
            OR (status IN (${statusList(DELIVERY_TAKEOVER_STATUSES)})
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= now())
            OR status IN ('delivery_unknown', 'reconciling', 'delivered')
         )
    `;
}

/** A varredura ESCOPADA do trabalho entregável — inclui o TAKEOVER. */
export function deliverableStatement(tenant_id: string, agent_id: string, limit: number) {
  return sql`
      SELECT id, status, attempt, payload_type, delivery_outcome,
             EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS age_ms
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND turn_id IS NOT NULL
         AND (
               (status IN (${statusList(DELIVERY_CLAIMABLE_STATUSES)})
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
            OR (status IN (${statusList(DELIVERY_TAKEOVER_STATUSES)})
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= now())
         )
       ORDER BY created_at ASC
       LIMIT ${limit}
    `;
}

/** A varredura ESCOPADA da fila de reconciliação. */
export function reconciliationStatement(tenant_id: string, agent_id: string, limit: number) {
  return sql`
      SELECT id, status, attempt, payload_type, delivery_outcome,
             EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS age_ms
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND turn_id IS NOT NULL
         AND status IN ('delivery_unknown', 'reconciling', 'delivered')
       ORDER BY created_at ASC
       LIMIT ${limit}
    `;
}

/**
 * SÓ o TAKEOVER, isolado. Existe para o EXPLAIN e para nada mais: a varredura
 * de produção o combina com o gate de backoff num `OR`, e o planejador pode
 * resolver esse `OR` com um `BitmapOr` de dois índices — o que esconderia um
 * dos dois estar ausente. Isolado, a pergunta "o predicado de takeover é
 * indexado?" tem uma resposta só.
 */
export function takeoverOnlyStatement(tenant_id: string, agent_id: string, limit: number) {
  return sql`
      SELECT id, status, attempt
        FROM ${outbound_messages}
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND status IN (${statusList(DELIVERY_TAKEOVER_STATUSES)})
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= now()
       ORDER BY created_at ASC
       LIMIT ${limit}
    `;
}

/**
 * `EXPLAIN (FORMAT JSON)` de uma das declarações acima. Sem `ANALYZE`: o que
 * se quer afirmar é o PLANO escolhido, não o tempo — e um teste que medisse
 * tempo seria instável no CI.
 */
export async function explainStatement(
  statement: ReturnType<typeof deliverableStatement>,
): Promise<string> {
  const result = await db.execute(sql`EXPLAIN (FORMAT JSON) ${statement}`);
  const rows = result.rows as unknown as Array<Record<string, unknown>>;
  return JSON.stringify(rows[0]?.['QUERY PLAN'] ?? rows[0] ?? {});
}

// ---------------------------------------------------------------------------
// Projeção crua ⇒ candidato tipado
// ---------------------------------------------------------------------------

type RawCandidate = {
  id: string;
  status: string;
  attempt: number;
  payload_type: string | null;
  delivery_outcome: string | null;
  age_ms: string | number | null;
};

/**
 * `payload_type` nulo é impossível numa row com `turn_id` (o CHECK
 * `outbound_messages_durable_row_complete_check` da 121 o exige) e todas as
 * varreduras filtram `turn_id IS NOT NULL`. O `?? 'text'` existe para não
 * inventar um `as` sobre `null` — e é inalcançável por construção, não um
 * default de comportamento.
 */
function mapCandidates(rows: unknown): RecoveryCandidate[] {
  return Array.from(rows as RawCandidate[]).map((r) => ({
    outbound_id: r.id,
    status: r.status,
    attempt: Number(r.attempt),
    payload_type: (r.payload_type ?? 'text') as OutboundPayloadType,
    delivery_outcome: r.delivery_outcome as OutboundDeliveryOutcome | null,
    age_ms: Math.max(0, Number(r.age_ms ?? 0)),
  }));
}
