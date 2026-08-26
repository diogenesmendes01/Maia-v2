/**
 * Issue #632 (fatia C da épica #506) — o CLAIM, o LEASE e o FENCE da entrega.
 *
 * Este módulo é o único lugar do repositório que muda o estado de ENTREGA de
 * uma linha de `outbound_messages`. `outbound-outbox-repo.ts` (#631) cria a
 * linha numa transação com o turno; daqui em diante quem manda é o fence.
 *
 * ─── A forma das declarações, e por que ela é a garantia ────────────────────
 *
 * Toda mutação abaixo é UM `UPDATE ... WHERE ... RETURNING`. Nenhuma é
 * "SELECT elegível, depois UPDATE". A diferença não é estilo:
 *
 *  1. sob READ COMMITTED, dois workers que disputam a MESMA row serializam no
 *     lock de row — o segundo bloqueia e, quando o primeiro commita, RE-AVALIA
 *     o `WHERE` contra a versão nova (EvalPlanQual). Como o vencedor deixou
 *     `lease_expires_at` no futuro, o predicado de takeover do perdedor passa a
 *     ser falso e ele volta ZERO linhas. Com SELECT-depois-UPDATE os dois leem
 *     o mesmo estado elegível e os dois escrevem;
 *  2. todo relógio é o do PostgreSQL (`now()`), nunca `Date.now()` do processo.
 *     Elegibilidade por lease é comparação de instantes entre máquinas; com
 *     relógios locais, um nó adiantado em 30s toma leases vivas — takeover
 *     falso, que aqui significa DUPLO ENVIO.
 *
 * ─── Por que NÃO entra no barril `src/db/repositories.ts` ───────────────────
 *
 * Mesma razão de `outbound-outbox-repo.ts`: este módulo importa `auditTx`
 * (`@/governance/audit.js`), que importa `auditRepo` de `@/db/repositories.js`.
 * Reexportar daqui fecharia o ciclo. Os consumidores importam por caminho
 * direto.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { mensagens, outbound_messages } from '../schema.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import { auditTx } from '@/governance/audit.js';
import { statusList } from './turn-fence-sql.js';
import type { OutboundDeliveryOutcome } from '@/runtime/outbound/contract.js';
import {
  DELIVERY_CLAIMABLE_STATUSES,
  DELIVERY_TAKEOVER_STATUSES,
  MULTIPART_RESOLVED_STATUSES,
  DeliveryFenceError,
  statusForOutcome,
  type DeliveryClaimResult,
  type DeliveryClaimRejection,
} from '@/runtime/outbound/delivery-contract.js';

/** A row do outbox, como o Drizzle a projeta. */
export type OutboundDeliveryRow = typeof outbound_messages.$inferSelect;

type ClaimRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  attempt: number;
  claim_token: string;
  claimed_by: string;
  lease_expires_at: string;
  status: string;
};

/**
 * Estados a partir dos quais NENHUM claim de entrega é concedido, porque a
 * linha já saiu do ciclo de entrega.
 *
 * Serve só para CLASSIFICAR a recusa (`terminal` vs `not_eligible`) no caminho
 * de fracasso — a exclusão real vem de `DELIVERY_CLAIMABLE_STATUSES` +
 * `DELIVERY_TAKEOVER_STATUSES` não os conterem. Duas listas afirmando a mesma
 * coisa por caminhos diferentes é defesa em profundidade; usar esta como o
 * predicado do UPDATE, não — seria uma lista de exclusão, e uma lista de
 * exclusão erra por omissão (um estado novo entraria por default).
 */
const DELIVERY_TERMINAL_STATUSES = [
  'delivered',
  'completed',
  'delivery_unknown',
  'reconciling',
  'failed_terminal',
  'cancelled',
  // Issue #633 — a DLQ do outbox. Terminal para o worker de entrega: a única
  // saída é o rearmamento MANUAL auditado (`rearmOutboundByOperator`), que
  // devolve a linha a `retryable` antes de rearmar o job. Sem esta entrada a
  // recusa do claim seria classificada como `not_eligible` e um pico na DLQ
  // apareceria como contenção entre réplicas.
  'dead_letter',
  // Vocabulário legado da 063 — uma row do caminho síncrono antigo também
  // não é trabalho de entrega deste worker.
  'sent',
  'failed',
  'unknown',
] as const;

export const outboundDeliveryRepo = {
  /**
   * CLAIM ATÔMICO da entrega. Uma ÚNICA declaração decide o dono.
   *
   * Elegibilidade:
   *   - `pending`/`retryable` com `next_attempt_at` vencido (ou nulo) — o
   *     backoff é do PostgreSQL, não da BullMQ;
   *   - `claimed`/`sending` com `lease_expires_at <= now()` — takeover de dono
   *     morto.
   *
   * `sending` ser tomável NÃO autoriza reenvio, e a forma como esta declaração
   * garante isso é ESTRUTURAL, não uma checagem no worker:
   *
   *     status = CASE WHEN status = 'sending' THEN 'sending' ELSE 'claimed' END
   *
   * O takeover de uma linha em `sending` a MANTÉM em `sending`. Ela não volta
   * para `claimed`. Como `markSending` exige `status = 'claimed'` no WHERE, o
   * sucessor de uma chamada em voo é literalmente incapaz de enviar — não há
   * caminho de código que o permita, mesmo que alguém apague a checagem de
   * `claimDisposition`. O que ele pode fazer é registrar
   * `cancelled_after_send_unknown` e mandar a linha para reconciliação (#633).
   *
   * A alternativa que foi DESCARTADA: devolver o status ANTERIOR num
   * `RETURNING`. O `RETURNING` de um `UPDATE` no Postgres enxerga os valores
   * NOVOS, então recuperar o antigo exigiria um CTE ou um self-join — e o
   * snapshot do CTE é tirado no início da declaração, enquanto o `WHERE` é
   * RE-AVALIADO pelo EvalPlanQual contra a versão nova da row. Sob contenção
   * os dois podem discordar, e a discordância se manifestaria como "achei que
   * era `claimed`, então enviei" numa linha que estava em `sending`. Ou seja:
   * exatamente o duplo envio, por um caminho difícil de ver.
   *
   * Efeito atômico: incrementa `attempt` (a tentativa CANÔNICA nasce aqui),
   * gera `claim_token` novo, grava `claimed_by`/`lease_expires_at`.
   *
   * Resultado vazio significa "não adquirido" — não é erro, e NÃO autoriza
   * entregar.
   */
  async tryClaimDelivery(input: {
    outbound_id: string;
    worker_id: string;
    lease_ms: number;
  }): Promise<DeliveryClaimResult> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const leaseSeconds = input.lease_ms / 1000;
    const result = await db.execute<ClaimRow>(sql`
      UPDATE ${outbound_messages}
         SET status           = CASE WHEN status = 'sending' THEN 'sending' ELSE 'claimed' END,
             claimed_by       = ${input.worker_id},
             claim_token      = gen_random_uuid(),
             lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
             attempt          = attempt + 1
       WHERE tenant_id = ${tenant_id}
         AND agent_id  = ${agent_id}
         AND id        = ${input.outbound_id}::uuid
         AND turn_id IS NOT NULL
         AND (
               (status IN (${statusList(DELIVERY_CLAIMABLE_STATUSES)})
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
            OR (status IN (${statusList(DELIVERY_TAKEOVER_STATUSES)})
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= now())
         )
      -- O status devolvido aqui e o valor NOVO, e e justamente ele que carrega
      -- a disposicao: claimed = ninguem tocou o adaptador, pode enviar;
      -- sending = a chamada anterior ficou em voo, NAO pode.
      RETURNING id, tenant_id, agent_id, attempt, claim_token, claimed_by,
                lease_expires_at, status
    `);
    const row = (result.rows as unknown as ClaimRow[])[0];
    if (!row) {
      // Distinguir os três fracassos custa UMA leitura escopada, feita só no
      // caminho de fracasso. Sem ela, "linha de outro tenant", "corrida
      // perdida" e "linha já terminal" seriam o mesmo ponto na métrica — e as
      // três pedem triagem oposta (bug de roteamento, operação normal, job
      // duplicado).
      const [current] = await db
        .select({ status: outbound_messages.status })
        .from(outbound_messages)
        .where(
          and(
            eq(outbound_messages.tenant_id, tenant_id),
            eq(outbound_messages.agent_id, agent_id),
            eq(outbound_messages.id, input.outbound_id),
          ),
        )
        .limit(1);
      const reason: DeliveryClaimRejection = !current
        ? 'not_found'
        : (DELIVERY_TERMINAL_STATUSES as readonly string[]).includes(current.status)
          ? 'terminal'
          : 'not_eligible';
      return { ok: false, reason };
    }
    return {
      ok: true,
      claim: {
        outbound_id: row.id,
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        attempt: Number(row.attempt),
        claim_token: row.claim_token,
        worker_id: row.claimed_by,
        lease_expires_at: new Date(row.lease_expires_at),
        status_after_claim: row.status,
      },
    };
  },

  /**
   * Renova a lease do claim VIGENTE. É o heartbeat da entrega.
   *
   * Três condições, todas necessárias, e a terceira é a que costuma faltar:
   *   - `claim_token = <o meu>` — só o dono renova (fencing);
   *   - `status IN (claimed, sending)` — linha fora do ciclo não tem lease;
   *   - `lease_expires_at > now()` — **uma lease VENCIDA não se renova.** Um
   *     processo que passou cinco minutos em GC não recupera a posse só porque
   *     ninguém a tomou ainda; o sucessor não ter chegado não devolve posse a
   *     quem a perdeu.
   */
  async renewDeliveryLease(input: {
    outbound_id: string;
    claim_token: string;
    lease_ms: number;
  }): Promise<{ ok: true; lease_expires_at: Date } | { ok: false }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const leaseSeconds = input.lease_ms / 1000;
    const result = await db.execute<{ lease_expires_at: string }>(sql`
      UPDATE ${outbound_messages}
         SET lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND id          = ${input.outbound_id}::uuid
         AND claim_token = ${input.claim_token}::uuid
         AND status      IN ('claimed', 'sending')
         AND lease_expires_at > now()
      RETURNING lease_expires_at
    `);
    const row = (result.rows as unknown as Array<{ lease_expires_at: string }>)[0];
    if (!row) return { ok: false };
    return { ok: true, lease_expires_at: new Date(row.lease_expires_at) };
  },

  /**
   * `claimed -> sending`, COM FENCE. O último passo antes de o adaptador ser
   * tocado.
   *
   * Existe como gravação própria — e não como um campo do claim — porque é
   * exatamente ela que torna o crash a seguir DIAGNOSTICÁVEL: uma linha
   * encontrada em `sending` com lease morta significa "a chamada foi iniciada e
   * o desfecho nunca foi registrado", e é o único estado a partir do qual o
   * sucessor sabe que NÃO pode reenviar. Sem esta escrita, o crash pós-envio e
   * o crash pré-envio deixariam a linha idêntica em `claimed`, e o sucessor
   * reenviaria uma mensagem já entregue.
   *
   * LANÇA em recusa: quem chama está prestes a produzir um efeito externo.
   */
  async markSending(input: { outbound_id: string; claim_token: string }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute(sql`
      UPDATE ${outbound_messages}
         SET status = 'sending'
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND id          = ${input.outbound_id}::uuid
         AND claim_token = ${input.claim_token}::uuid
         AND status      = 'claimed'
         AND lease_expires_at > now()
      RETURNING id
    `);
    if (result.rows.length === 0) {
      throw new DeliveryFenceError({
        outbound_id: input.outbound_id,
        operation: 'mark_sending',
        reason: 'fence_rejected',
      });
    }
  },

  /**
   * Persiste o resultado NORMALIZADO da tentativa, COM FENCE.
   *
   * O estado de destino NÃO é escolhido pelo chamador: vem de
   * `statusForOutcome` (delivery-contract.ts), a tabela única que decide o que
   * cada um dos sete desfechos significa. É o que impede que um call site
   * decida, sozinho, chamar `accepted_unconfirmed` de `delivered`.
   *
   * `sent_at`/`provider_timestamp` só são carimbados no desfecho CONFIRMADO.
   * Preenchê-los em `accepted_unconfirmed` faria um dashboard de latência de
   * entrega contar envios que ninguém sabe se chegaram.
   *
   * `next_attempt_at` só avança quando o desfecho admite nova tentativa; nos
   * demais ele é PRESERVADO — e não zerado.
   *
   * A tentação era zerá-lo "para tirar a linha da fila". Duas razões contra, e
   * a primeira é o banco falando: o CHECK
   * `outbound_messages_durable_row_complete_check` (migração 121) exige
   * `next_attempt_at IS NOT NULL` em toda row com `turn_id`, então o UPDATE
   * seria RECUSADO — foi assim que esta linha foi descoberta, com o Postgres
   * real reprovando quatro sondas de uma vez. A segunda é que zerar não
   * ganharia nada: o índice de trabalho `idx_outbound_messages_ready` filtra
   * por `status IN ('pending','retryable')`, então uma linha em `delivered`,
   * `delivery_unknown`, `failed_terminal` ou `cancelled` já está fora dele pelo
   * ESTADO. O que retira a linha da fila é o estado, não o timestamp.
   *
   * A posse é LIBERADA na mesma declaração — MENOS quando o chamador declara
   * que vai CONTINUAR o ciclo (`continues_to_completed`), e essa exceção é o
   * ponto:
   *
   * Para o CICLO COMPLETO (`delivery.ts`), `delivered` NÃO é o fim: falta o
   * histórico e o `completed`, e essa transição é FENCED pelo mesmo
   * `claim_token`. Soltar a posse aqui deixaria `completeDeliveryTx` sem fence
   * para exibir — ela recusaria a própria continuação do trabalho, a linha
   * ficaria eternamente `delivered` sem histórico, e o desfecho seria
   * SILENCIOSO porque o chamador trata recusa de fence como "outro worker
   * assumiu". (Foi exatamente isso que o Postgres real mostrou: `delivered`,
   * zero linhas de histórico, sonda vermelha.)
   *
   * Em todo outro caso a posse é solta, e isso inclui o caminho SÍNCRONO de
   * `output-dispatch.ts`: ele grava o histórico por conta própria e nunca
   * chama `completeDeliveryTx`, então segurar a posse ali deixaria uma linha
   * `delivered` com dono que nunca mais volta. Por isso o flag é do CHAMADOR e
   * não uma dedução a partir do desfecho: quem sabe se o ciclo continua é quem
   * o está conduzindo.
   *
   * Soltar é o comportamento certo por default: uma linha terminal com dono
   * vivo faria o recovery de #633 esperar por um worker que já foi embora. O
   * CHECK `outbound_messages_claim_complete_check` da 121 exige o trio inteiro
   * ou ausente, e as duas pernas abaixo respeitam isso.
   *
   * A janela que sobra, declarada: um crash ENTRE `delivered` e `completed`
   * deixa a linha com claim vivo e lease que vai vencer. Ela NÃO volta a ser
   * reivindicável (`delivered` não está em `DELIVERY_TAKEOVER_STATUSES`), o
   * que é o comportamento correto — a mensagem chegou, reenviar seria
   * duplicar. O que falta é o histórico, e recuperá-lo é reconciliação (#633),
   * não entrega.
   */
  async recordDeliveryOutcome(input: {
    outbound_id: string;
    claim_token: string;
    outcome: OutboundDeliveryOutcome;
    provider_message_id?: string | null;
    last_error_code?: string | null;
    /** Backoff em segundos. Só usado quando o desfecho admite nova tentativa. */
    retry_in_seconds?: number;
    /**
     * O chamador vai seguir para `completed` com este MESMO `claim_token`?
     * Só o ciclo completo (`delivery.ts`) diz `true`, e só em `delivered`.
     * Default `false` — soltar a posse é o comportamento seguro.
     */
    continues_to_completed?: boolean;
  }): Promise<{ status: string }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const status = statusForOutcome(input.outcome);
    const confirmed = input.outcome === 'accepted_confirmed';
    const retryable = status === 'retryable';
    const mantemPosse = confirmed && input.continues_to_completed === true;
    const retrySeconds = input.retry_in_seconds ?? 0;
    const result = await db.execute(sql`
      UPDATE ${outbound_messages}
         SET status              = ${status},
             delivery_outcome    = ${input.outcome},
             provider_message_id = ${input.provider_message_id ?? null},
             last_error_code     = ${input.last_error_code ?? null},
             sent_at             = ${confirmed ? sql`now()` : sql`sent_at`},
             provider_timestamp  = ${confirmed ? sql`now()` : sql`provider_timestamp`},
             next_attempt_at     = ${
               retryable ? sql`now() + make_interval(secs => ${retrySeconds})` : sql`next_attempt_at`
             },
             claimed_by          = ${mantemPosse ? sql`claimed_by` : sql`NULL`},
             claim_token         = ${mantemPosse ? sql`claim_token` : sql`NULL`},
             lease_expires_at    = ${mantemPosse ? sql`lease_expires_at` : sql`NULL`}
       WHERE tenant_id   = ${tenant_id}
         AND agent_id    = ${agent_id}
         AND id          = ${input.outbound_id}::uuid
         AND claim_token = ${input.claim_token}::uuid
         AND status      IN ('claimed', 'sending')
      RETURNING id
    `);
    if (result.rows.length === 0) {
      // Sem `lease_expires_at > now()` no WHERE, de propósito e ao contrário de
      // `markSending`: aqui o efeito externo JÁ ocorreu, e recusar a gravação
      // porque a lease venceu DURANTE a chamada ao provedor deixaria a linha em
      // `sending` com um desfecho conhecido que ninguém registrou. O que
      // protege continua sendo o `claim_token`: se um sucessor já tomou a
      // linha, ele gerou token novo, esta gravação volta zero e o worker antigo
      // NÃO confirma — que é o critério de pronto nº 2, literal.
      throw new DeliveryFenceError({
        outbound_id: input.outbound_id,
        operation: 'record_delivery_outcome',
        reason: 'fence_rejected',
      });
    }
    return { status };
  },

  /**
   * `delivered -> completed` + o HISTÓRICO, na MESMA transação.
   *
   * ─── Por que uma transação, e não duas escritas ─────────────────────────
   *
   * A issue pede "persistir histórico idempotentemente → `completed`". A forma
   * fraca seria inserir em `mensagens` e depois marcar `completed`: a janela
   * entre as duas escritas é uma janela de crash — a mesma que #631 fechou para
   * o commit.
   *
   * Aqui a idempotência é do ESTADO, e é atômica por construção: ou as duas
   * escritas acontecem, ou nenhuma. Uma linha em `completed` tem histórico; uma
   * em `delivered` não tem. Um retry a partir de `delivered` reexecuta as duas,
   * e um retry a partir de `completed` não é sequer elegível — `completed` não
   * está em `DELIVERY_CLAIMABLE_STATUSES` nem em `DELIVERY_TAKEOVER_STATUSES`,
   * então o claim recusa com `terminal` antes de chegar aqui.
   *
   * ─── Issue #635: a idempotência do estado ganha uma CHAVE ────────────────
   *
   * A garantia acima é real e continua valendo, mas ela tem exatamente UM
   * escritor. A #635 acrescenta o segundo — a reconciliação, que FABRICA o
   * histórico perdido na janela `delivered -> completed` —, e a partir de dois
   * escritores a unicidade não pode mais ser efeito colateral de uma máquina de
   * estados.
   *
   * Por isso o INSERT passa a carimbar `outbound_id` e a terminar em
   * `ON CONFLICT DO NOTHING` sobre a unique parcial
   * `mensagens_outbound_history_uq` (migração 135). O conflito representa
   * idempotência LEGÍTIMA e uma coisa só — "o histórico deste artefato já
   * existe" —, porque não há outro predicado naquele índice que possa colidir.
   * `DO NOTHING` e não `DO UPDATE`: o histórico é o FATO do que foi dito, e
   * reescrevê-lo seria admitir que a segunda gravação pode discordar da
   * primeira.
   *
   * A transição para `completed` acontece de qualquer forma. Ela é a verdade
   * sobre o CICLO ("este artefato terminou"), e a row de `mensagens` já
   * existente é a prova de que o histórico está lá — recusar a conclusão porque
   * a linha já existia deixaria o artefato preso em `delivered` para sempre.
   *
   * FENCED: sem posse não se conclui. A auditoria vai no MESMO `tx` — a prova
   * durável de que a resposta chegou ao histórico não pode viver fora da
   * transação que a criou.
   */
  async completeDeliveryTx(input: {
    outbound_id: string;
    claim_token: string;
    conversa_id: string;
    channel_id: string | null;
    in_reply_to: string;
    pessoa_id?: string | null;
    /** Conteúdo do histórico — o texto do ARTEFATO, nunca gerado de novo. */
    historico: {
      tipo: string;
      conteudo: string;
      metadata: Record<string, unknown>;
    };
  }): Promise<{ history_message_id: string | null; history_inserted: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return withTx(async (tx) => {
      const completed = await tx.execute(sql`
        UPDATE ${outbound_messages}
           SET status           = 'completed',
               claimed_by       = NULL,
               claim_token      = NULL,
               lease_expires_at = NULL
         WHERE tenant_id   = ${tenant_id}
           AND agent_id    = ${agent_id}
           AND id          = ${input.outbound_id}::uuid
           AND claim_token = ${input.claim_token}::uuid
           AND status      = 'delivered'
        RETURNING id
      `);
      if (completed.rows.length === 0) {
        throw new DeliveryFenceError({
          outbound_id: input.outbound_id,
          operation: 'complete_delivery',
          reason: 'fence_rejected',
        });
      }

      // `midia_url: null` LITERAL, e não um campo do input: é a política de
      // retenção de #635 §Retenção sendo ESTRUTURAL. A referência de mídia de
      // #630 é `local_path`/`storage_object`; persistir um caminho de arquivo
      // temporário no histórico seria um link morto no dia seguinte e uma pista
      // de onde o binário mora, numa tabela sem expiração própria.
      const inserted = await tx
        .insert(mensagens)
        .values({
          tenant_id,
          agent_id,
          conversa_id: input.conversa_id,
          channel_id: input.channel_id,
          direcao: 'out',
          tipo: input.historico.tipo,
          conteudo: input.historico.conteudo,
          midia_url: null,
          metadata: input.historico.metadata,
          outbound_id: input.outbound_id,
          processada_em: new Date(),
        } as never)
        // O `where` é o PREDICADO do índice parcial, não um filtro de linhas: o
        // PostgreSQL só infere um índice parcial como alvo do `ON CONFLICT`
        // quando o predicado é informado. Sem ele a declaração é recusada com
        // "there is no unique or exclusion constraint matching the ON CONFLICT
        // specification" — em runtime, dentro da transação que fecha a entrega.
        .onConflictDoNothing({
          target: [mensagens.tenant_id, mensagens.agent_id, mensagens.outbound_id],
          where: sql`${mensagens.outbound_id} IS NOT NULL`,
        })
        .returning({ id: mensagens.id });
      // Vazio = a unique parcial da 135 recusou porque o histórico deste
      // artefato já existe. Ver o bloco §Issue #635 acima.
      const history_message_id = inserted[0]?.id ?? null;

      await auditTx(tx, {
        acao: 'outbound_delivery_completed',
        ...(input.pessoa_id ? { pessoa_id: input.pessoa_id } : {}),
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        metadata: {
          outbound_id: input.outbound_id,
          history_message_id,
          history_inserted: history_message_id !== null,
          from_status: 'delivered',
          to_status: 'completed',
        },
      });

      return { history_message_id, history_inserted: history_message_id !== null };
    });
  },

  /**
   * Issue #635 — MULTIPART: existe artefato ANTERIOR do mesmo turno ainda NÃO
   * resolvido?
   *
   * Devolve o de MENOR `sequence_in_turn` entre os bloqueantes (não um
   * booleano) porque o log e o runbook precisam dizer *qual* parte segura a
   * fila: "o turno parou" sem apontar a linha obriga o operador a repetir esta
   * consulta à mão.
   *
   * ─── A forma da declaração ────────────────────────────────────────────────
   *
   * `NOT IN (<resolvidos>)` e não `IN (<bloqueantes>)`, ao contrário da
   * disciplina usual deste arquivo — e a inversão é deliberada. O vocabulário
   * autoritativo é `MULTIPART_RESOLVED_STATUSES` (lista de INCLUSÃO no
   * contrato); escrever a lista complementar aqui criaria uma segunda lista a
   * manter em sincronia, e a divergência apareceria como resposta fora de
   * ordem. Com a negação, o SQL DERIVA do contrato: um estado novo no
   * vocabulário de #630 é BLOQUEANTE até alguém acrescentá-lo à lista de
   * resolvidos, que é o default seguro.
   *
   * `status` é NOT NULL desde a 063, então a lógica ternária do `NOT IN` não
   * tem por onde produzir NULL e deixar uma linha escapar.
   *
   * O índice é `outbound_messages_turn_sequence_uq` (121): unique PARCIAL em
   * (tenant_id, agent_id, turn_id, sequence_in_turn) WHERE turn_id IS NOT NULL
   * — exatamente o prefixo de igualdade mais a coluna do range e do ORDER BY.
   */
  async findBlockingEarlierArtifact(input: {
    turn_id: string;
    sequence_in_turn: number;
  }): Promise<{ outbound_id: string; sequence_in_turn: number; status: string } | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute(sql`
      SELECT id AS outbound_id, sequence_in_turn, status
        FROM ${outbound_messages}
       WHERE tenant_id        = ${tenant_id}
         AND agent_id         = ${agent_id}
         AND turn_id          = ${input.turn_id}::uuid
         AND sequence_in_turn < ${input.sequence_in_turn}
         AND status NOT IN (${statusList(MULTIPART_RESOLVED_STATUSES)})
       ORDER BY sequence_in_turn ASC
       LIMIT 1
    `);
    const rows = result.rows as unknown as Array<{
      outbound_id: string;
      sequence_in_turn: number;
      status: string;
    }>;
    return rows[0] ?? null;
  },

  /**
   * A linha, por id, no escopo corrente. Leitura ÚNICA do worker — ele carrega
   * por ID e nunca por conteúdo, então a projeção é a row inteira.
   */
  async findById(outbound_id: string): Promise<OutboundDeliveryRow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const [row] = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.id, outbound_id),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
