/**
 * Issue #632 (fatia C da épica #506) — o CICLO DE ENTREGA.
 *
 * Responsabilidade isolada e única: dado o `outbound_id` de uma linha já
 * COMMITADA por #631, levá-la do outbox ao usuário — ou até um estado honesto
 * sobre o que aconteceu.
 *
 * O ciclo, na ordem exata da issue:
 *
 *   carregar por ID
 *     → claim atômico com lease/fencing
 *     → validar tenant/agent/canal/sessão
 *     → verificar deadline
 *     → marcar `sending` COM FENCE
 *     → chamar o adaptador com a idempotency key e o `AbortSignal`
 *     → persistir o resultado normalizado
 *     → `delivered`
 *     → persistir histórico idempotentemente
 *     → `completed`
 *
 * ─── As três coisas que este módulo NÃO faz ─────────────────────────────────
 *
 * **Não gera texto.** O payload vem do ARTEFATO (`payload_json`), validado de
 * novo pela união de #630 antes de virar chamada. Isso não é economia: é o
 * requisito "o texto renderizado final é o mesmo em retry". Uma segunda passada
 * de cognição produziria outro texto, outro `payload_hash`, outra
 * `logical_dedupe_key` — e a idempotência inteira desapareceria justamente na
 * tentativa em que ela precisa funcionar.
 *
 * **Não decide política de retry.** Ele registra o desfecho normalizado e
 * pergunta a `delivery-contract.ts` se reenviar é seguro. Quando a resposta é
 * `reconcile`, a linha para em `delivery_unknown` e quem age é #633.
 *
 * **Não marca `delivered` porque a chamada foi iniciada.** `statusForOutcome`
 * é a única autoridade sobre o estado de destino, e nela `accepted_unconfirmed`
 * vira `delivery_unknown`.
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { counter, METRIC } from '@/observability/metrics.js';
import { forChannel, forCurrentAgentChannel, type LineOutput } from '@/gateway/line-output.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { outboundDeliveryRepo } from '@/db/repositories/outbound-delivery-repo.js';
import { getTurnExecutionContext } from '@/runtime/turns/execution-context.js';
import {
  parseOutboundPayload,
  type OutboundPayload,
  type OutboundPayloadType,
  type OutboundProviderChannel,
} from './contract.js';
import {
  DeliveryFenceError,
  autoResendAllowed,
  claimDisposition,
  isDeliveryUnknown,
  normalizeProviderOutcome,
  outboundDeliveryWorkerId,
  statusForOutcome,
  type OutboundDeliveryClaim,
} from './delivery-contract.js';
import { sendPayloadToProvider, type ProviderCallTarget } from './provider-adapter.js';
import { withOutboxEgress } from './egress-guard.js';

/**
 * O canal de egresso desta fatia. Fechado em `whatsapp` porque
 * `OUTBOUND_PROVIDER_CHANNELS` (#630) tem um membro só — um canal novo entra
 * no contrato, na capability de idempotência e aqui, na mesma PR.
 */
const EGRESS_CHANNEL: OutboundProviderChannel = 'whatsapp';

/** Por que a entrega não foi tentada. Vocabulário fechado, sem texto livre. */
export type DeliverySkipReason =
  | 'claim_not_acquired'
  | 'row_not_found'
  | 'scope_mismatch'
  | 'deadline_exceeded'
  | 'takeover_of_in_flight_send';

export type DeliveryResult =
  | { delivered: true; outbound_id: string; provider_message_id: string | null }
  | { delivered: false; outbound_id: string; reason: DeliverySkipReason }
  | { delivered: false; outbound_id: string; reason: 'provider'; status: string };

export type DeliverOutboundInput = {
  outbound_id: string;
  /**
   * TTL da lease de entrega. Default: o mesmo do turno, porque uma entrega é
   * um passo DENTRO da vida útil de um turno e uma lease de entrega mais longa
   * que a do turno permitiria a um worker sem turno continuar entregando.
   */
  lease_ms?: number;
  /**
   * O JID do destinatário. Vem do CHAMADOR e não da row: o outbox não persiste
   * telefone (é PII, e #630 manteve o destinatário fora do payload de
   * propósito). Quem chama resolve a pessoa e o JID sob o mesmo escopo.
   */
  jid: string;
  /** Canal (linha) de saída. `null` resolve o canal único ativo, fail-closed. */
  channel_id?: string | null;
  /**
   * Sobrescreve a fronteira de saída. Existe para o teste de integração poder
   * injetar um provedor FAKE sem mockar o módulo inteiro — o caminho de
   * produção segue idêntico abaixo desta linha.
   */
  line?: LineOutput;
};

/**
 * Entrega UMA linha do outbox. É a função que um worker de fila chama com o
 * `outbound_id` do payload do job (id determinístico em `delivery-job.ts`).
 *
 * Nunca lança por desfecho de entrega — os desfechos são valores, e os sete
 * estão cobertos. Lança apenas por erro de PLATAFORMA (banco fora, escopo
 * ausente), que é o que deve virar retry de job e depois DLQ.
 */
export async function deliverOutbound(input: DeliverOutboundInput): Promise<DeliveryResult> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const lease_ms = input.lease_ms ?? config.TURN_LEASE_TTL_MS;

  // ── (1) CARREGAR POR ID. Nada vem do payload do job além do id. ──────────
  const row = await outboundDeliveryRepo.findById(input.outbound_id);
  if (!row) {
    // `findById` já é escopado por (tenant, agent): ausência aqui significa
    // "não existe NESTE escopo", que cobre ao mesmo tempo linha inexistente e
    // linha de outro tenant. As duas dão o mesmo desfecho de propósito — dizer
    // "existe, mas não é sua" já seria vazamento de existência.
    counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: 'not_found' });
    return { delivered: false, outbound_id: input.outbound_id, reason: 'row_not_found' };
  }

  // ── (2) VALIDAR ESCOPO. Fail-closed, ANTES do claim. ─────────────────────
  //
  // Redundante com o `WHERE` de `findById` por construção, e mantido assim de
  // propósito: se algum dia alguém trocar a leitura por uma não escopada, esta
  // guarda é o que impede a entrega cruzada em vez de um comentário.
  if (row.tenant_id !== tenant_id || row.agent_id !== agent_id) {
    logger.error(
      { outbound_id: input.outbound_id, ops_alert: true },
      'outbound.delivery_scope_mismatch',
    );
    return { delivered: false, outbound_id: input.outbound_id, reason: 'scope_mismatch' };
  }
  // Row LEGADA (anterior ao outbox durável) não é trabalho deste worker: sem
  // `turn_id` não há artefato, sem artefato não há payload a entregar, e
  // "entregar" uma row assim seria inventar conteúdo.
  if (!row.turn_id || !row.payload_json || !row.provider_idempotency_key) {
    return { delivered: false, outbound_id: input.outbound_id, reason: 'row_not_found' };
  }

  // ── (3) CLAIM ATÔMICO com lease e fencing. ───────────────────────────────
  const claimed = await outboundDeliveryRepo.tryClaimDelivery({
    outbound_id: input.outbound_id,
    worker_id: outboundDeliveryWorkerId(),
    lease_ms,
  });
  if (!claimed.ok) {
    counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: claimed.reason });
    return { delivered: false, outbound_id: input.outbound_id, reason: 'claim_not_acquired' };
  }
  counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: 'acquired' });
  const claim = claimed.claim;

  // ── (4) TAKEOVER DE CHAMADA EM VOO. Antes de qualquer coisa. ─────────────
  //
  // Uma linha tomada em `sending` significa: alguém iniciou a chamada ao
  // provedor e morreu sem registrar o desfecho. A mensagem PODE estar no
  // telefone do usuário. Este é o critério de pronto nº 3, e a resposta não é
  // "tente de novo": é registrar honestamente que não se sabe.
  if (claimDisposition(claim.status_after_claim) === 'delivery_unknown') {
    await finalizeOutcome(claim, {
      outcome: 'cancelled_after_send_unknown',
      last_error_code: 'takeover_of_in_flight_send',
      payload_type: row.payload_type as OutboundPayloadType,
    });
    return {
      delivered: false,
      outbound_id: input.outbound_id,
      reason: 'takeover_of_in_flight_send',
    };
  }

  // ── (5) O ARTEFATO. Revalidado, NUNCA regerado. ──────────────────────────
  //
  // `parseOutboundPayload` é fail-closed: um `payload_json` que não satisfaz a
  // união de #630 (schema evoluído, row adulterada) é rejeitado AQUI, com a
  // posse na mão, e vira `rejected_terminal` — nunca uma tentativa de enviar
  // "o que der".
  let payload: OutboundPayload;
  try {
    payload = parseOutboundPayload(row.payload_json);
  } catch {
    await finalizeOutcome(claim, {
      outcome: 'rejected_terminal',
      last_error_code: 'payload_schema_invalid',
      payload_type: (row.payload_type ?? 'text') as OutboundPayloadType,
    });
    return {
      delivered: false,
      outbound_id: input.outbound_id,
      reason: 'provider',
      status: 'failed_terminal',
    };
  }

  // ── (6) DEADLINE e CANCELAMENTO. ─────────────────────────────────────────
  //
  // Duas fontes, e a mais apertada vence: o `AbortSignal` do turno dono (#504,
  // via ALS — presente quando a entrega roda dentro da tentativa) e a lease
  // desta própria entrega. Não há relógio novo: `lease_expires_at` veio do
  // PostgreSQL no claim, então a comparação é com um instante que o banco
  // emitiu.
  const signal = getTurnExecutionContext()?.signal ?? null;
  if (signal?.aborted) {
    // Abortado ANTES de tocar o adaptador: nada saiu, e dizer isso é a única
    // coisa honesta. `cancelled_before_send` é auto-retryable por semântica.
    await finalizeOutcome(claim, {
      outcome: 'cancelled_before_send',
      last_error_code: 'turn_ownership_lost',
      payload_type: payload.type,
    });
    counter(METRIC.OUTBOUND_LEASE_LOST, { reason: 'aborted' });
    return { delivered: false, outbound_id: input.outbound_id, reason: 'deadline_exceeded' };
  }
  if (claim.lease_expires_at.getTime() <= Date.now()) {
    // A lease nasceu vencida — só acontece com relógio de processo muito à
    // frente do banco, ou lease absurdamente curta. Enviar com posse já morta
    // é o cenário do zumbi, então recusamos antes do efeito.
    counter(METRIC.OUTBOUND_LEASE_LOST, { reason: 'lease_expired' });
    await finalizeOutcome(claim, {
      outcome: 'cancelled_before_send',
      last_error_code: 'lease_expired_before_send',
      payload_type: payload.type,
    });
    return { delivered: false, outbound_id: input.outbound_id, reason: 'deadline_exceeded' };
  }

  // ── (7) A LINHA (canal/sessão). Fail-closed: sem canal não há envio. ─────
  const line =
    input.line ??
    (input.channel_id
      ? await forChannel({ tenant_id, agent_id, channel_id: input.channel_id })
      : await forCurrentAgentChannel(null));

  // ── (8) `sending` COM FENCE. O último passo antes do efeito. ─────────────
  //
  // Se esta gravação for recusada, o `claim_token` já não é o vigente: um
  // sucessor tomou a linha. O worker antigo PARA aqui — não envia e não
  // confirma —, que é o critério de pronto nº 2.
  try {
    await outboundDeliveryRepo.markSending({
      outbound_id: claim.outbound_id,
      claim_token: claim.claim_token,
    });
  } catch (err) {
    if (err instanceof DeliveryFenceError) {
      counter(METRIC.OUTBOUND_LEASE_LOST, { reason: err.reason });
      logger.warn(
        { outbound_id: claim.outbound_id, operation: err.operation, ops_alert: true },
        'outbound.delivery_fence_rejected_before_send',
      );
      return { delivered: false, outbound_id: input.outbound_id, reason: 'claim_not_acquired' };
    }
    throw err;
  }

  // ── (9) O ADAPTADOR, com a chave idempotente e o `AbortSignal`. ──────────
  const target: ProviderCallTarget = {
    line,
    jid: input.jid,
    channel: EGRESS_CHANNEL,
    provider_idempotency_key: row.provider_idempotency_key,
    ...(signal ? { signal } : {}),
  };
  // #634 — ESCOPO DE EGRESSO DO OUTBOX. A fronteira única (`line-output.ts`)
  // recusa qualquer `send*` que não esteja dentro de um escopo declarado; este
  // é o escopo do caminho legítimo. Ele envolve SÓ a chamada ao adaptador, não
  // o ciclo inteiro: autorizar `deliverOutbound` de ponta a ponta autorizaria,
  // de quebra, qualquer envio que outro módulo fizesse durante a entrega.
  const observation = await withDeliveryHeartbeat(claim, lease_ms, () =>
    withOutboxEgress(claim.outbound_id, () => sendPayloadToProvider(payload, target)),
  );
  const outcome = normalizeProviderOutcome(observation);

  // ── (10) O RESULTADO NORMALIZADO, COM FENCE. ─────────────────────────────
  let status: string;
  try {
    status = await finalizeOutcome(claim, {
      outcome,
      last_error_code: 'error_code' in observation ? observation.error_code : null,
      provider_message_id:
        observation.kind === 'accepted_with_id' ? observation.provider_message_id : null,
      payload_type: payload.type,
      // ESTE ciclo continua: `delivered` é seguido de histórico + `completed`,
      // e essa transição é fenced pelo mesmo token.
      continues_to_completed: true,
    });
  } catch (err) {
    if (err instanceof DeliveryFenceError) {
      // A posse morreu DURANTE a chamada ao provedor. O efeito externo pode ter
      // acontecido e não podemos registrá-lo — mas também NÃO confirmamos nada,
      // e não reenviamos. Quem tem a lease vigente decide.
      counter(METRIC.OUTBOUND_LEASE_LOST, { reason: err.reason });
      logger.error(
        { outbound_id: claim.outbound_id, ops_alert: true },
        'outbound.delivery_fence_rejected_after_send',
      );
      return { delivered: false, outbound_id: input.outbound_id, reason: 'claim_not_acquired' };
    }
    throw err;
  }

  if (status !== 'delivered') {
    // Ponto único onde a política de reenvio é consultada. `autoResendAllowed`
    // é `false` para todo desfecho da família desconhecida cujo tipo de payload
    // não tem chave nativa no provedor — e nesse caso a linha fica em
    // `delivery_unknown`, fora do índice de trabalho, esperando #633.
    const resend = autoResendAllowed({
      outcome,
      channel: EGRESS_CHANNEL,
      payload_type: payload.type,
    });
    logger.info(
      {
        outbound_id: claim.outbound_id,
        attempt: claim.attempt,
        outcome,
        status,
        auto_resend_allowed: resend,
      },
      'outbound.delivery_not_confirmed',
    );
    return { delivered: false, outbound_id: input.outbound_id, reason: 'provider', status };
  }

  // ── (11) HISTÓRICO + `completed`, na MESMA transação. ────────────────────
  //
  // A idempotência do histórico é do ESTADO e é atômica: `delivered` = sem
  // histórico, `completed` = com histórico, e a transição carrega o INSERT.
  // Ver `completeDeliveryTx`.
  const provider_message_id =
    observation.kind === 'accepted_with_id' ? observation.provider_message_id : null;
  try {
    await outboundDeliveryRepo.completeDeliveryTx({
      outbound_id: claim.outbound_id,
      claim_token: claim.claim_token,
      conversa_id: row.conversa_id,
      channel_id: line.scope.channel_id,
      in_reply_to: row.in_reply_to,
      historico: buildHistorico(payload, {
        provider_message_id,
        jid: input.jid,
        in_reply_to: row.in_reply_to,
      }),
    });
  } catch (err) {
    if (err instanceof DeliveryFenceError) {
      counter(METRIC.OUTBOUND_LEASE_LOST, { reason: err.reason });
      logger.error(
        { outbound_id: claim.outbound_id, ops_alert: true },
        'outbound.delivery_history_fence_rejected',
      );
      // A mensagem CHEGOU (a linha está `delivered`). Não reenviar é o certo; o
      // histórico é reconciliável e a linha fica visível para #633.
      return { delivered: true, outbound_id: input.outbound_id, provider_message_id };
    }
    throw err;
  }

  return { delivered: true, outbound_id: input.outbound_id, provider_message_id };
}

// =====================================================================
// A PONTE COM O CAMINHO SÍNCRONO — substituindo o escopo emprestado de #631
// =====================================================================

/**
 * Posse de uma linha do outbox adquirida pelo caminho SÍNCRONO de
 * `src/agent/output-dispatch.ts`.
 *
 * ─── O que isto substitui, e por quê ────────────────────────────────────────
 *
 * #631 precisou de `recordInlineDeliveryOutcome` para não deixar toda linha
 * entregue em `pending` (o que faria esta fatia, ao subir, reenviar mensagens
 * já recebidas). Aquela função foi declarada provisória e tinha três buracos,
 * todos dentro do escopo desta issue:
 *
 *  1. **Sem claim, sem lease, sem fence.** Ela era um `UPDATE ... WHERE status
 *     = 'pending'`. Se um delivery worker já tivesse a linha, o caminho
 *     síncrono sobrescrevia o desfecho DELE. Aqui o claim é atômico e a
 *     gravação é fenced pelo `claim_token`: quem não tem posse não escreve.
 *  2. **Sem `sending`.** Um crash entre o `sendText` e a gravação deixava a
 *     linha em `pending` — indistinguível de "nunca tentada" — e o recovery a
 *     reenviaria. `beginInlineDelivery` marca `sending` ANTES do canal, então
 *     esse crash é diagnosticável e vira `delivery_unknown`, não reenvio.
 *  3. **Estado desonesto.** Ela mapeava `accepted_unconfirmed → delivered`.
 *     Aqui o estado vem de `statusForOutcome`, e lá `accepted_unconfirmed` é
 *     `delivery_unknown` — "o provedor aceitou" deixou de ser "o usuário
 *     recebeu".
 *
 * O que continua diferente do worker de verdade, e é #634: quem envia ainda é
 * o processo do turno, e o payload sai por `line.send*` montado no dispatcher
 * em vez de por `sendPayloadToProvider`. A POSSE, porém, já é a mesma.
 */
export type InlineDeliveryHandle = { claim: OutboundDeliveryClaim } | { claim: null };

/**
 * Reivindica a linha e a move para `sending`, imediatamente ANTES da chamada
 * ao canal.
 *
 * Duas gravações e não uma: o claim precisa vencer a corrida com um delivery
 * worker (e o vencedor é decidido no lock de row do PostgreSQL), e o
 * `sending` precisa ser fenced pelo token que o claim acabou de emitir.
 *
 * LANÇA quando a posse é negada. É deliberado e é o mesmo raciocínio do
 * `throw` de `commitOutboundIntent` (#631): a próxima linha do chamador é a
 * chamada ao canal, e um retorno `{ ok: false }` é ignorável — basta um `if`
 * esquecido para o envio acontecer sem posse.
 */
export async function beginInlineDelivery(
  outbound_id: string | null,
  lease_ms?: number,
): Promise<InlineDeliveryHandle> {
  // Sem linha durável (regime de rollback, worker sem turno) não há posse a
  // adquirir — e não havia registro a proteger. É o caminho `OutboundCommitSkip`
  // de #631, e ele continua legítimo até a #634.
  if (!outbound_id) return { claim: null };
  const claimed = await outboundDeliveryRepo.tryClaimDelivery({
    outbound_id,
    worker_id: outboundDeliveryWorkerId(),
    lease_ms: lease_ms ?? config.TURN_LEASE_TTL_MS,
  });
  if (!claimed.ok) {
    counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: claimed.reason });
    counter(METRIC.OUTBOUND_LEASE_LOST, { reason: 'fence_rejected' });
    throw new DeliveryFenceError({
      outbound_id,
      operation: 'begin_inline_delivery',
      reason: 'fence_rejected',
    });
  }
  counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: 'acquired' });
  const claim = claimed.claim;
  if (claimDisposition(claim.status_after_claim) === 'delivery_unknown') {
    // A linha estava em `sending`: uma chamada anterior ficou em voo. O
    // caminho síncrono NÃO reenvia — fecha honestamente e recusa.
    await finalizeOutcome(claim, {
      outcome: 'cancelled_after_send_unknown',
      last_error_code: 'takeover_of_in_flight_send',
      payload_type: 'text',
    });
    throw new DeliveryFenceError({
      outbound_id,
      operation: 'begin_inline_delivery',
      reason: 'fence_rejected',
    });
  }
  await outboundDeliveryRepo.markSending({
    outbound_id,
    claim_token: claim.claim_token,
  });
  return { claim };
}

/**
 * Persiste o desfecho da tentativa síncrona, COM FENCE.
 *
 * NÃO lança: quando ela roda, o efeito externo JÁ ocorreu. Uma exceção aqui não
 * desfaz o envio; ela trocaria uma linha desatualizada por um turno abortado. O
 * que mudou em relação a #631 é o que acontece na falha: a linha fica em
 * `sending` (não em `pending`), e `sending` é o estado que diz "a chamada foi
 * iniciada, o desfecho é desconhecido" — então o recovery de #633 reconcilia em
 * vez de reenviar.
 */
export async function recordInlineDelivery(
  handle: InlineDeliveryHandle,
  input: {
    outcome: Parameters<typeof statusForOutcome>[0];
    provider_message_id?: string | null;
    last_error_code?: string | null;
    payload_type: OutboundPayloadType;
  },
): Promise<void> {
  if (!handle.claim) return;
  try {
    await finalizeOutcome(handle.claim, input);
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        outbound_id: handle.claim.outbound_id,
        outcome: input.outcome,
        ops_alert: true,
      },
      'outbound.inline_outcome_record_failed',
    );
  }
}

/**
 * Grava o desfecho normalizado e emite as métricas da issue.
 *
 * Único ponto de emissão de `maia_outbound_delivery_unknown_total{channel}` e
 * de `maia_outbound_delivery_outcome_total`. Estar num lugar só é o que torna
 * verificável a afirmação "nenhum rótulo carrega destinatário, telefone ou
 * conteúdo": há UM conjunto de labels a auditar, e ele é literal.
 */
async function finalizeOutcome(
  claim: OutboundDeliveryClaim,
  input: {
    outcome: Parameters<typeof statusForOutcome>[0];
    last_error_code?: string | null;
    provider_message_id?: string | null;
    payload_type: OutboundPayloadType;
    /**
     * Só o ciclo completo segue para `completed` com este mesmo token. O
     * caminho síncrono de `output-dispatch.ts` grava o histórico por conta
     * própria e para em `delivered`, então ele NÃO pode segurar a posse: uma
     * linha `delivered` com dono que nunca volta é um worker fantasma.
     */
    continues_to_completed?: boolean;
  },
): Promise<string> {
  const { status } = await outboundDeliveryRepo.recordDeliveryOutcome({
    outbound_id: claim.outbound_id,
    claim_token: claim.claim_token,
    outcome: input.outcome,
    continues_to_completed: input.continues_to_completed === true,
    ...(input.provider_message_id !== undefined
      ? { provider_message_id: input.provider_message_id }
      : {}),
    ...(input.last_error_code !== undefined ? { last_error_code: input.last_error_code } : {}),
    retry_in_seconds: backoffSeconds(claim.attempt),
  });
  // Labels: só vocabulário FECHADO. `channel` é `OUTBOUND_PROVIDER_CHANNELS`,
  // `outcome` são os sete de #506, `kind` é o `payload_type` de #630. Nenhum
  // deles vem de entrada do usuário, e o sanitizador de `labels.ts` derrubaria
  // qualquer chave nova de qualquer forma.
  counter(METRIC.OUTBOUND_DELIVERY_OUTCOME, {
    outcome: input.outcome,
    channel: EGRESS_CHANNEL,
    kind: input.payload_type,
  });
  if (isDeliveryUnknown(input.outcome)) {
    counter(METRIC.OUTBOUND_DELIVERY_UNKNOWN, { channel: EGRESS_CHANNEL });
  }
  return status;
}

/**
 * Issue #633 — o HEARTBEAT da entrega, ligado.
 *
 * A #632 entregou `renewDeliveryLease` e declarou a dívida em uma linha: *nada
 * a chama em loop*. Sem heartbeat, a lease default (`TURN_LEASE_TTL_MS`, 60s)
 * cobre exatamente uma entrega — e uma chamada ao provedor que passe disso
 * (mídia grande, sessão do WhatsApp reconectando, rede degradada) faz a lease
 * vencer COM A CHAMADA EM VOO. A varredura de takeover então encontra a linha
 * em `sending` com lease morta e a move para `delivery_unknown`, enquanto a
 * primeira tentativa ainda está viva e vai gravar o desfecho real.
 *
 * O resultado disso não é duplo envio — o fence do `claim_token` impede que os
 * dois escrevam —, mas é pior do que parece: a tentativa VIVA perde a posse e
 * seu desfecho CONHECIDO é descartado, e a linha fica marcada como incerta
 * quando alguém sabia a resposta. Trocar informação por incerteza é o oposto do
 * que a épica quer.
 *
 * ─── As três decisões deste helper ─────────────────────────────────────────
 *
 * **Um terço da lease.** Duas renovações cabem dentro de cada TTL, então uma
 * renovação perdida (blip do banco) não expira a posse. É a mesma proporção que
 * o heartbeat do turno usa.
 *
 * **A renovação RECUSADA não aborta a chamada.** `renewDeliveryLease` devolve
 * `{ ok: false }` quando o token não é mais o vigente ou a lease já venceu — e
 * nesse ponto a chamada ao provedor já está em voo. Abortá-la não desfaria o
 * efeito externo; só trocaria um desfecho conhecido por um `aborted`. O que
 * protege continua sendo o fence na GRAVAÇÃO: se um sucessor tomou a linha,
 * `recordDeliveryOutcome` volta zero linhas e esta tentativa não confirma nada.
 * A perda é REGISTRADA (`OUTBOUND_LEASE_LOST{reason:lease_expired}`) para que o
 * operador veja leases dimensionadas curto demais, que é a causa mais comum de
 * takeover falso.
 *
 * **O timer é `unref`ado.** Um `setInterval` vivo segura o event loop; num
 * processo que já drenou a fila, isso é um shutdown que não termina.
 */
async function withDeliveryHeartbeat<T>(
  claim: OutboundDeliveryClaim,
  lease_ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  const every = Math.max(1_000, Math.floor(lease_ms / 3));
  let lost = false;
  const timer = setInterval(() => {
    void (async () => {
      if (lost) return;
      try {
        const renewed = await outboundDeliveryRepo.renewDeliveryLease({
          outbound_id: claim.outbound_id,
          claim_token: claim.claim_token,
          lease_ms,
        });
        if (!renewed.ok) {
          lost = true;
          counter(METRIC.OUTBOUND_LEASE_LOST, { reason: 'lease_expired' });
          logger.warn(
            { outbound_id: claim.outbound_id, ops_alert: true },
            'outbound.delivery_heartbeat_lost',
          );
        }
      } catch (err) {
        // Um blip do banco NÃO é perda de posse: a lease continua válida até
        // vencer, e a próxima batida pode renová-la. Tratar erro como perda
        // faria uma indisponibilidade de 1s virar takeover.
        logger.debug(
          { outbound_id: claim.outbound_id, err: (err as Error).message },
          'outbound.delivery_heartbeat_failed',
        );
      }
    })();
  }, every);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Backoff exponencial em SEGUNDOS, aplicado só quando o desfecho admite nova
 * tentativa. Teto de uma hora — o gate é `next_attempt_at` no PostgreSQL, então
 * quem espera é o banco e não um timer de processo que morre com o container.
 */
function backoffSeconds(attempt: number): number {
  return Math.min(3600, 2 ** Math.max(0, Math.min(attempt, 12)) * 5);
}

/**
 * O que vai para o histórico da conversa.
 *
 * Deriva do ARTEFATO — o mesmo texto que foi enviado, nunca uma nova
 * renderização. `midia_url` fica de fora: a referência de mídia de #630 é
 * `local_path`/`storage_object` e não uma URL, e persistir um caminho de
 * arquivo temporário no histórico seria um link morto no dia seguinte.
 */
function buildHistorico(
  payload: OutboundPayload,
  ctx: { provider_message_id: string | null; jid: string; in_reply_to: string },
): { tipo: string; conteudo: string; metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {
    whatsapp_id: ctx.provider_message_id,
    remote_jid: ctx.jid,
    in_reply_to: ctx.in_reply_to,
    outbound_payload_type: payload.type,
  };
  switch (payload.type) {
    case 'text':
      return { tipo: 'texto', conteudo: payload.text, metadata };
    case 'status_fallback':
      return {
        tipo: 'texto',
        conteudo: payload.text,
        metadata: { ...metadata, fallback_reason: payload.reason },
      };
    case 'audio':
      // `source_text` e não o áudio: é o texto que gerou a voz, persistido em
      // #630 exatamente para que o histórico e o fallback tivessem o conteúdo.
      return { tipo: 'audio', conteudo: payload.source_text, metadata };
    case 'document':
      return {
        tipo: 'documento',
        conteudo: payload.caption ?? '',
        metadata: { ...metadata, file_name: payload.file_name },
      };
    case 'reaction':
      return {
        tipo: 'evento',
        conteudo: payload.emoji,
        metadata: { ...metadata, target_provider_message_id: payload.target_provider_message_id },
      };
    case 'interactive_poll':
      return {
        tipo: 'texto',
        conteudo: payload.question,
        metadata: { ...metadata, poll_options: payload.options },
      };
    default: {
      const _never: never = payload;
      void _never;
      throw new TypeError('buildHistorico: payload fora do contrato de #630');
    }
  }
}
