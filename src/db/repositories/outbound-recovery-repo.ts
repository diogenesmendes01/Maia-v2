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

/**
 * #506 §Auditoria mínima — a correlação devolvida pelos CAS da reconciliação.
 *
 * Vem do PRÓPRIO `UPDATE ... RETURNING` e nunca de uma leitura posterior: entre
 * a leitura e a escrita a linha pode mudar de dono, e a trilha descreveria um
 * estado que não coexistiu com a transição que ela documenta.
 */
type ReconciledRow = {
  id: string;
  turn_id: string | null;
  payload_type: string | null;
  conversa_id: string;
  in_reply_to: string;
  attempt: number;
  delivery_outcome: string | null;
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
    // #506 §Auditoria mínima — `outbound.reconciled`, resultado
    // `resend_idempotent`, na MESMA transação do CAS.
    //
    // Esta é a ÚNICA escrita da recuperação que autoriza um efeito externo
    // repetido, e é por isso que ela é a que menos pode acontecer sem trilha:
    // depois do fato, "por que esta mensagem foi enviada duas vezes?" só tem
    // resposta se existir a linha que diz quem autorizou e com que fundamento.
    // Auditoria que falha reverte a promoção — a linha continua
    // `delivery_unknown` e o próximo tick decide de novo, o que é seguro
    // justamente porque nada saiu.
    return withTx(async (tx) => {
      const result = await tx.execute<ReconciledRow>(sql`
        UPDATE ${outbound_messages}
           SET status          = 'retryable',
               next_attempt_at = now(),
               last_error_code = 'reconciled_idempotent_resend'
         WHERE tenant_id = ${tenant_id}
           AND agent_id  = ${agent_id}
           AND id        = ${input.outbound_id}::uuid
           AND status    = 'delivery_unknown'
        RETURNING id, turn_id, payload_type, conversa_id, in_reply_to, attempt,
                  delivery_outcome
      `);
      const row = (result.rows as unknown as ReconciledRow[])[0];
      if (!row) return { promoted: false };
      await auditTx(tx, {
        acao: 'outbound_reconciled',
        conversa_id: row.conversa_id,
        mensagem_id: row.in_reply_to,
        alvo_id: row.id,
        entidade_alvo: 'outbound_messages',
        metadata: {
          outbound_id: row.id,
          turn_id: row.turn_id,
          payload_type: row.payload_type,
          attempt: Number(row.attempt),
          // Vocabulário FECHADO de `RECONCILIATION_RESULTS`.
          result: 'resend_idempotent',
          from_status: 'delivery_unknown',
          to_status: 'retryable',
          // O desfecho incerto que motivou a reconciliação. Sem ele a trilha
          // diria "reenviou" sem dizer de que incerteza se estava saindo.
          delivery_outcome: row.delivery_outcome,
          // A afirmação que torna o reenvio defensável, escrita na trilha e não
          // só no código: a MESMA chave vai ao provedor, então uma eventual
          // primeira entrega e esta colidem no cliente do destinatário.
          reuses_provider_idempotency_key: true,
        },
      });
      return { promoted: true };
    });
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
    // #506 §Auditoria mínima — `outbound.reconciliation_started`, na MESMA
    // transação do CAS.
    //
    // O CAS `status = 'delivery_unknown'` é o que impede a linha duplicada: uma
    // linha já em `reconciling` volta zero e NÃO grava auditoria de novo, então
    // a trilha tem uma entrada por ESCALADA e não uma por tick da varredura.
    return withTx(async (tx) => {
      const result = await tx.execute<ReconciledRow>(sql`
        UPDATE ${outbound_messages}
           SET status = 'reconciling'
         WHERE tenant_id = ${tenant_id}
           AND agent_id  = ${agent_id}
           AND id        = ${input.outbound_id}::uuid
           AND status    = 'delivery_unknown'
        RETURNING id, turn_id, payload_type, conversa_id, in_reply_to, attempt,
                  delivery_outcome
      `);
      const row = (result.rows as unknown as ReconciledRow[])[0];
      if (!row) return { marked: false };
      await auditTx(tx, {
        acao: 'outbound_reconciliation_started',
        conversa_id: row.conversa_id,
        mensagem_id: row.in_reply_to,
        alvo_id: row.id,
        entidade_alvo: 'outbound_messages',
        metadata: {
          outbound_id: row.id,
          turn_id: row.turn_id,
          payload_type: row.payload_type,
          attempt: Number(row.attempt),
          delivery_outcome: row.delivery_outcome,
          from_status: 'delivery_unknown',
          to_status: 'reconciling',
          // Por que a plataforma parou: o provedor não deduplica este
          // `payload_type`, então reenviar produziria uma SEGUNDA mensagem.
          // É o fundamento da espera humana, e ele pertence à trilha.
          escalation_reason: 'provider_idempotency_unavailable_for_payload_type',
        },
      });
      return { marked: true };
    });
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
   * ─── Issue #635: o predicado deixa de ser uma heurística ──────────────────
   *
   * A #633 perguntou por `metadata->>'in_reply_to'`, porque era o único campo
   * comum entre os dois escritores. Isso não é uma chave, e ERRA num caso real
   * desta fatia: numa resposta MULTIPART os dois artefatos do turno respondem
   * ao MESMO ingresso, então o histórico do artefato 0 fazia a leitura
   * responder "já existe" para o artefato 1 — e o artefato 1 era concluído sem
   * histórico. Falha silenciosa, com a linha em `completed` mentindo.
   *
   * Agora a primeira perna é a CHAVE (`mensagens.outbound_id`, unique parcial
   * `mensagens_outbound_history_uq` da 135), que identifica o ARTEFATO e não o
   * turno.
   *
   * A segunda perna é a de TRANSIÇÃO, e é conservadora de propósito: uma row de
   * histórico gravada ANTES desta migração não tem `outbound_id`, e para ela o
   * único vínculo disponível continua sendo o ingresso. Fabricar por cima dela
   * duplicaria a resposta na conversa do usuário — o dano é assimétrico, então
   * a perna legada BLOQUEIA a fabricação em vez de permiti-la. Ela é limitada a
   * `outbound_id IS NULL`, então não reintroduz o falso positivo de multipart
   * para nada que esta fatia escreva.
   */
  async hasHistoryFor(input: {
    outbound_id: string;
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
         AND direcao     = 'out'
         AND (
               outbound_id = ${input.outbound_id}::uuid
            OR (
                 outbound_id IS NULL
                 AND conversa_id = ${input.conversa_id}::uuid
                 AND metadata->>'in_reply_to' = ${input.in_reply_to}
               )
             )
    `);
    return Number((result.rows as unknown as Array<{ n: string }>)[0]?.n ?? 0) > 0;
  },

  /**
   * Issue #635 — tudo que a FABRICAÇÃO do histórico precisa, numa leitura.
   *
   * O artefato (`payload_json`) e os metadados do provedor vêm da PRÓPRIA
   * linha do outbox, que é imutável depois de pronta para envio (#630/#631):
   * é a mesma entrada que o ciclo de entrega teve. `parseOutboundPayload`
   * revalida no consumidor, fail-closed.
   *
   * ─── O que NÃO vem da linha do outbox, e de onde vem ─────────────────────
   *
   * `channel_id`: `outbound_messages` não tem a coluna (a 090 a acrescentou a
   * `conversas`/`mensagens`, não ao ledger de saída), e no caminho de envio ela
   * vem de `line.scope.channel_id` — um objeto de PROCESSO que não existe mais
   * quando a reconciliação roda. A fonte durável equivalente é o `channel_id`
   * do INGRESSO: é a linha em que a conversa acontece, é o valor que
   * `sendOutbound` resolveria, e é o único que satisfaz a FK composta
   * `mensagens_channel_scope_fk`.
   *
   * `remote_jid`: também ausente por decisão — o outbox não persiste
   * destinatário (#630 manteve telefone fora do payload). Recuperado do
   * INGRESSO, que é a mesma fonte que
   * `resolveOutboundJid` prefere no caminho de envio. Pode vir `null` (ingresso
   * sem `remote_jid`), e nesse caso o histórico fabricado o registra como
   * `null` em vez de derivar um JID a partir do telefone: derivar seria
   * AFIRMAR um endereço que ninguém observou, e a fatia inteira existe para
   * não afirmar o que não se sabe.
   */
  async artifactForHistoryRecovery(outbound_id: string): Promise<{
    conversa_id: string;
    in_reply_to: string;
    channel_id: string | null;
    provider_message_id: string | null;
    payload_json: unknown;
    remote_jid: string | null;
  } | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute(sql`
      SELECT o.conversa_id,
             o.in_reply_to,
             i.channel_id,
             o.provider_message_id,
             o.payload_json,
             i.metadata->>'remote_jid' AS remote_jid
        FROM ${outbound_messages} o
        LEFT JOIN ${mensagens} i
               ON i.tenant_id = o.tenant_id
              AND i.agent_id  = o.agent_id
              AND i.id        = o.in_reply_to
       WHERE o.tenant_id = ${tenant_id}
         AND o.agent_id  = ${agent_id}
         AND o.id        = ${outbound_id}::uuid
       LIMIT 1
    `);
    const rows = result.rows as unknown as Array<{
      conversa_id: string;
      in_reply_to: string;
      channel_id: string | null;
      provider_message_id: string | null;
      payload_json: unknown;
      remote_jid: string | null;
    }>;
    return rows[0] ?? null;
  },

  /**
   * Issue #635 — FABRICA o histórico perdido e conclui, na MESMA transação.
   *
   * ─── O que a #633 recusou fazer, e por que agora é seguro ────────────────
   *
   * A #633 parou aqui com um `ops_alert` e esta justificativa: *"não fabrico o
   * histórico porque o texto teria de ser re-renderizado a partir do payload,
   * duplicando `buildHistorico`"*. A objeção era sobre DUPLICAR a projeção — e
   * a resposta desta fatia não é duplicá-la: é `src/runtime/outbound/historico.ts`,
   * uma definição única que os DOIS caminhos importam. O texto não é
   * re-renderizado; ele é PROJETADO de um artefato imutável, pela mesma função
   * pura que o ciclo de entrega já usava. Ver o cabeçalho daquele módulo.
   *
   * ─── Por que uma transação, e por que ON CONFLICT DO NOTHING ─────────────
   *
   * Duas réplicas do sweeper podem decidir a mesma coisa no mesmo tick. O CAS
   * `status = 'delivered'` elege UM vencedor para a transição — mas o INSERT do
   * histórico acontece na MESMA transação, então sem a unique da 135 o perdedor
   * poderia inserir antes de descobrir que perdeu. Com ela, o segundo INSERT é
   * um no-op e o segundo `UPDATE` volta zero linhas: uma row de histórico, uma
   * transição, uma auditoria.
   *
   * NÃO é fenced pelo `claim_token`, pela mesma razão de
   * `completeDeliveredWithHistoryTx`: o dono original morreu, e o token dele —
   * se ainda estiver na row — é justamente o que impede qualquer um de concluir.
   */
  async recoverHistoryAndCompleteTx(input: {
    outbound_id: string;
    conversa_id: string;
    in_reply_to: string;
    channel_id: string | null;
    historico: { tipo: string; conteudo: string; metadata: Record<string, unknown> };
  }): Promise<{ completed: boolean; history_message_id: string | null }> {
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
      if (moved.rows.length === 0) return { completed: false, history_message_id: null };

      // `midia_url: null` LITERAL — a política de retenção de #635 §Retenção,
      // estrutural e não por limpeza posterior. Ver `historico.ts`.
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
        // O `where` é o PREDICADO do índice parcial: sem ele o PostgreSQL não
        // infere `mensagens_outbound_history_uq` como alvo do `ON CONFLICT`.
        .onConflictDoNothing({
          target: [mensagens.tenant_id, mensagens.agent_id, mensagens.outbound_id],
          where: sql`${mensagens.outbound_id} IS NOT NULL`,
        })
        .returning({ id: mensagens.id });
      const history_message_id = inserted[0]?.id ?? null;

      await auditTx(tx, {
        acao: 'outbound_delivery_completed',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        metadata: {
          outbound_id: input.outbound_id,
          history_message_id,
          from_status: 'delivered',
          to_status: 'completed',
          recovered_by: 'reconciliation',
          // A distinção que o operador precisa ver na trilha: esta row de
          // histórico NÃO foi gravada pelo processo que enviou a mensagem — ela
          // foi projetada do artefato depois, porque aquele processo morreu na
          // janela. O texto é o mesmo; a proveniência não.
          history_fabricated: history_message_id !== null,
        },
      });
      // #506 §Auditoria mínima — `outbound.reconciled`.
      //
      // Linha SEPARADA de `outbound_delivery_completed`, e a separação é o
      // ponto: aquela diz "o ciclo desta saída fechou"; esta diz "quem fechou
      // foi a RECONCILIAÇÃO, e o histórico que existe agora foi projetado do
      // artefato porque o processo que enviou morreu na janela". Colapsar as
      // duas apagaria a proveniência — e a pergunta que se faz depois de um
      // incidente é exatamente essa.
      await auditTx(tx, {
        acao: 'outbound_reconciled',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        entidade_alvo: 'outbound_messages',
        metadata: {
          outbound_id: input.outbound_id,
          result: 'history_fabricated',
          from_status: 'delivered',
          to_status: 'completed',
          history_message_id,
          // A afirmação que o operador precisa ler sem abrir o código: a
          // reconciliação NÃO tocou o provedor. Nada foi reenviado.
          provider_contacted: false,
        },
      });

      return { completed: true, history_message_id };
    });
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
      // #506 §Auditoria mínima — `outbound.reconciled`, resultado
      // `history_recovered`: o histórico JÁ estava lá (o caminho síncrono o
      // gravou) e só o estado ficou para trás. Nada foi inserido e nada foi
      // enviado; a série `history_recovered` mede ruído de concorrência, e a
      // `history_fabricated` mede crash — conflatá-las na trilha esconderia a
      // segunda dentro do volume da primeira.
      await auditTx(tx, {
        acao: 'outbound_reconciled',
        conversa_id: input.conversa_id,
        mensagem_id: input.in_reply_to,
        alvo_id: input.outbound_id,
        entidade_alvo: 'outbound_messages',
        metadata: {
          outbound_id: input.outbound_id,
          result: 'history_recovered',
          from_status: 'delivered',
          to_status: 'completed',
          provider_contacted: false,
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
