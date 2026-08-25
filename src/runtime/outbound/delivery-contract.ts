/**
 * Issue #632 (fatia C da épica #506) — contrato PURO do delivery worker.
 *
 * Irmão de `contract.ts` (#630) e da mesma natureza: sem `db`, sem I/O, sem
 * ALS, sem relógio. Aqui mora o VOCABULÁRIO que o repositório executa em SQL
 * (`src/db/repositories/outbound-delivery-repo.ts`) e que o ciclo de entrega
 * orquestra (`src/runtime/outbound/delivery.ts`).
 *
 * A razão de ser puro é a mesma de #504: a decisão "este desfecho autoriza
 * reenvio?" é a decisão mais perigosa da épica inteira, e ela precisa ser
 * testável sem Postgres, num só lugar, em vez de espalhada em `if`s do worker.
 *
 * ─── O que esta fatia acrescenta ao vocabulário de #630 ─────────────────────
 *
 * #630 declarou os SETE desfechos normalizados do provedor e a lista curta dos
 * que admitem retry automático. O que faltava — e é o corpo desta fatia — é:
 *
 *   1. a NORMALIZAÇÃO: o que o adaptador devolve (ou lança) vira exatamente um
 *      daqueles sete, e nunca "dois" (sucesso/erro);
 *   2. o ESTADO em que a linha para depois de cada desfecho, nomeado
 *      honestamente — `delivered` só quando houve confirmação, nunca porque a
 *      chamada foi iniciada;
 *   3. a CAPABILITY de idempotência do provedor, por tipo de payload, porque
 *      o Baileys honra chave nativa em UM tipo só;
 *   4. a POLÍTICA de reenvio, que é função de (2) e (3) e de mais nada.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isAutoRetryable,
  type OutboundDeliveryOutcome,
  type OutboundPayloadType,
  type OutboundProviderChannel,
  type OutboundStatusV2,
} from './contract.js';

// =====================================================================
// 1. ELEGIBILIDADE DO CLAIM
// =====================================================================

/**
 * Estados em que a linha está disponível para um claim NOVO de entrega —
 * ninguém a possui, ou ninguém a possuiu ainda.
 *
 * É EXATAMENTE `OUTBOUND_SELECTABLE_STATUSES` de #630, que por sua vez é o
 * predicado parcial do índice `idx_outbound_messages_ready` (migração 121). Os
 * três são a mesma lista de propósito: divergir faz a seleção deixar de ser
 * indexada e virar seq scan na tabela mais quente do caminho de resposta.
 *
 * O gate de `next_attempt_at` NÃO está aqui: é condição de RELÓGIO, e o
 * relógio autoritativo é o do PostgreSQL (`now()`), nunca o do processo.
 */
export const DELIVERY_CLAIMABLE_STATUSES = ['pending', 'retryable'] as const;

/**
 * Estados em que a linha JÁ TEM dono e só pode ser tomada quando a lease
 * venceu. É o takeover, e ele existe porque um worker pode morrer sem aviso.
 *
 * `sending` está aqui, e essa é a decisão mais delicada da fatia. Ela NÃO
 * significa "reenvie": significa que a linha volta a ter dono para que alguém
 * possa DECIDIR o que fazer com ela. O que o sucessor faz ao tomar uma linha
 * em `sending` está em `claimDisposition` abaixo — e não é enviar.
 *
 * O que NÃO está aqui, e a ausência é o critério de pronto nº 3:
 * `delivered`, `completed`, `delivery_unknown`, `reconciling`,
 * `failed_terminal`, `cancelled`. Uma linha que já chegou a qualquer um desses
 * NÃO é trabalho de entrega — é trabalho de reconciliação (#633) ou nada. Um
 * claim que as alcançasse seria o reenvio cego que a épica existe para impedir.
 */
export const DELIVERY_TAKEOVER_STATUSES = ['claimed', 'sending'] as const;

// =====================================================================
// 2b. A ORDEM DO MULTIPART (#635)
// =====================================================================

/**
 * Estados em que um artefato ANTERIOR do mesmo turno já se RESOLVEU — isto é,
 * a pergunta "esta parte da resposta ainda pode aparecer no telefone do
 * usuário, depois?" tem resposta definitiva.
 *
 * É a lista que autoriza a entrega do artefato SEGUINTE. A política escrita
 * está em `docs/runbooks/outbound-recovery.md` §3; o que segue é por que cada
 * membro está aqui e — mais importante — por que os ausentes estão ausentes.
 *
 *   `completed`      — entregue e historiado. Resolvido no sentido pleno.
 *   `delivered`      — chegou ao usuário; falta o histórico. Para a ORDEM isso
 *                      basta: quem lê a conversa no telefone já viu esta parte.
 *   `failed_terminal`— o provedor recusou. Nunca vai chegar, então não há
 *                      ordem a preservar em relação a ela.
 *   `cancelled`      — nunca saiu e nunca sairá (inclui a saída "sem envio").
 *   `dead_letter`    — a plataforma desistiu. A decisão seguinte é humana, e
 *                      travar o resto do turno esperando por ela transformaria
 *                      um artefato morto num bloqueio permanente da conversa.
 *
 * ─── Quem NÃO está, e por quê ─────────────────────────────────────────────
 *
 * `delivery_unknown` e `reconciling`. Elas são o caso INTERESSANTE: a mensagem
 * PODE ter chegado e a reconciliação PODE reenviá-la (quando o provedor
 * deduplica o tipo). Se o artefato seguinte fosse entregue agora e o anterior
 * aparecesse depois, o usuário leria a resposta fora de ordem — e a ordem é o
 * que #505 gastou uma fatia inteira para garantir no ingresso. Bloquear é a
 * escolha honesta: o turno para, `maia_outbound_pending_age_seconds` sobe, e o
 * operador vê exatamente uma linha incerta em vez de uma conversa embaralhada.
 *
 * `pending`, `retryable`, `claimed`, `sending` — trabalho em curso, óbvio.
 *
 * ─── Por que uma lista de INCLUSÃO ────────────────────────────────────────
 *
 * Mesma razão de `DELIVERY_CLAIMABLE_STATUSES`: uma lista de EXCLUSÃO erra por
 * omissão. Um estado novo acrescentado ao vocabulário de #630 entraria por
 * default como "resolvido" e destravaria a ordem sem que ninguém decidisse
 * isso. Aqui ele entra como BLOQUEANTE até alguém escrever o contrário.
 */
export const MULTIPART_RESOLVED_STATUSES = [
  'completed',
  'delivered',
  'failed_terminal',
  'cancelled',
  'dead_letter',
] as const;

/**
 * Este estado de um artefato anterior LIBERA o artefato seguinte?
 *
 * Existe como função e não como `.includes()` solto nos call sites porque é a
 * única pergunta que autoriza uma saída a passar na frente de outra — e um
 * predicado invertido num `if` seria a resposta fora de ordem.
 */
export function multipartArtifactResolved(status: string): boolean {
  return (MULTIPART_RESOLVED_STATUSES as readonly string[]).includes(status);
}

/**
 * O que o worker faz com a linha que ele acabou de reivindicar.
 *
 * Esta função é o coração do critério "crash/timeout depois do fake provider
 * aceitar não vira reenvio", e ela é pura de propósito: a decisão não pode
 * depender de o worker anterior ter conseguido escrever alguma coisa — ele
 * pode ter morrido no meio do syscall.
 *
 * A entrada é o estado da linha DEPOIS do claim, e ele carrega a distinção
 * porque o claim não normaliza `sending` de volta para `claimed`:
 *
 *  - `claimed` — a linha estava em `pending`/`retryable` (claim novo) ou em
 *    `claimed` com lease morta (o dono anterior morreu ANTES de tocar o
 *    adaptador). Nenhuma chamada foi iniciada e enviar é seguro. É o único
 *    caminho que devolve `send`.
 *
 *  - `sending` — o dono anterior morreu DEPOIS de iniciar a chamada e ANTES de
 *    registrar o desfecho. O que aconteceu com a mensagem é literalmente
 *    desconhecido: pode ter sido entregue. Reenviar aqui é a duplicata clássica
 *    do outbox. A linha vai para `delivery_unknown` e a política é de #633 —
 *    reconciliar, esperar ou escalar, NUNCA reenviar imediatamente às cegas.
 *
 * Esta função é a SEGUNDA camada. A primeira é estrutural e está no SQL: o
 * `markSending` exige `status = 'claimed'`, então uma linha tomada em `sending`
 * não consegue avançar para o envio nem que este `if` desapareça.
 */
export type ClaimDisposition = 'send' | 'delivery_unknown';

export function claimDisposition(status_after_claim: string): ClaimDisposition {
  return status_after_claim === 'sending' ? 'delivery_unknown' : 'send';
}

/** Por que o claim de entrega não foi concedido. Label de métrica, fechado. */
export const DELIVERY_CLAIM_REJECTIONS = [
  /** A linha não existe NO ESCOPO (tenant+agent) corrente. */
  'not_found',
  /** Existe, mas outro worker tem lease viva — ou o estado não é elegível. */
  'not_eligible',
  /** Existe e já é TERMINAL. Distinto de `not_eligible` de propósito: uma
   *  linha terminal nunca voltará a ser elegível, então insistir é desperdício
   *  e um pico aqui significa job duplicado, não contenção. */
  'terminal',
] as const;

export type DeliveryClaimRejection = (typeof DELIVERY_CLAIM_REJECTIONS)[number];

/** Posse concedida sobre uma linha do outbox. O que o worker precisa carregar. */
export type OutboundDeliveryClaim = {
  outbound_id: string;
  tenant_id: string;
  agent_id: string;
  /** Tentativa CANÔNICA — vem do PostgreSQL, nunca de `job.attemptsMade`. */
  attempt: number;
  /** O FENCE. Toda gravação desta tentativa exige este valor no WHERE. */
  claim_token: string;
  worker_id: string;
  lease_expires_at: Date;
  /**
   * Estado da linha DEPOIS do claim — `claimed` ou `sending`. É o que
   * `claimDisposition` consome, e a razão de o claim não normalizar `sending`
   * de volta para `claimed` está documentada em `tryClaimDelivery`.
   */
  status_after_claim: string;
};

export type DeliveryClaimResult =
  | { ok: true; claim: OutboundDeliveryClaim }
  | { ok: false; reason: DeliveryClaimRejection };

// =====================================================================
// 2. IDENTIDADE DO WORKER DE ENTREGA
// =====================================================================

let cachedDeliveryWorkerId: string | null = null;

/**
 * Identidade ÚNICA e ESTÁVEL deste processo enquanto dono de claims de ENTREGA.
 *
 * `<hostname>:<pid>:outbound:<rand>`. O infixo `outbound` distingue-a de
 * `turnWorkerId()` (`:turn:`) porque um mesmo processo pode possuir um turno E
 * uma linha do outbox ao mesmo tempo — e `claimed_by` é diagnóstico, então
 * colapsar os dois faria a trilha juntar duas posses diferentes numa só.
 *
 * O sufixo aleatório é pela mesma razão de #504: o PID é reciclado pelo kernel
 * e um container que reinicia pode voltar com o MESMO par hostname:pid. O que
 * impede a escrita do zumbi continua sendo o `claim_token`, não este id.
 */
export function outboundDeliveryWorkerId(): string {
  cachedDeliveryWorkerId ??= `${hostname()}:${process.pid}:outbound:${randomUUID().slice(0, 8)}`;
  return cachedDeliveryWorkerId;
}

/** Só para teste: força uma nova identidade (simula outra réplica). */
export function __resetDeliveryWorkerIdForTest(): void {
  cachedDeliveryWorkerId = null;
}

// =====================================================================
// 3. CAPABILITY DE IDEMPOTÊNCIA DO PROVEDOR
// =====================================================================

/**
 * O adaptador honra uma chave idempotente NATIVA para este tipo de saída?
 *
 * ─── Por que isto é uma capability e não um booleano global ─────────────────
 *
 * #632 manda: "se o adaptador Baileys não suportar chave nativa em todos os
 * tipos, encapsular a limitação numa capability explícita, em vez de fingir
 * idempotência que não existe". Ele não suporta. O que foi VERIFICADO, e não
 * presumido, na fronteira única de saída (`src/gateway/line-output.ts`):
 *
 *   sendText(jid, text, { quoted?, view_once?, messageId? })  ← ACEITA
 *   sendDocument(jid, path, { mimetype, fileName, caption?, quoted? })
 *   sendVoice(jid, buf, { quoted? })
 *   sendPoll(jid, question, options)
 *   sendReaction(jid, whatsappId, emoji)
 *
 * Só `sendText` tem `messageId`. Ele desce para
 * `MiscMessageGenerationOptions.messageId` e vira verbatim o `id` da key da
 * mensagem (`generateWAMessageFromContent`: `id: options?.messageId ||
 * generateMessageIDV2()`), e o WhatsApp chaveia mensagem por
 * `(remoteJid, fromMe, id)` — então para texto a dedupe é do PROVEDOR, de
 * verdade. Para os outros quatro o Baileys gera id aleatório a cada chamada:
 * um reenvio produz uma mensagem NOVA no telefone do usuário.
 *
 * Um booleano global "o WhatsApp é idempotente" seria a mentira exata que a
 * issue proíbe: ele autorizaria retry de áudio e documento com base numa
 * garantia que só existe para texto.
 *
 * ─── O que a capability autoriza, e o que ela NÃO autoriza ──────────────────
 *
 * Ela é entrada de `retrySafety` e de mais nada. Ela NUNCA transforma
 * `delivery_unknown` em `delivered`: saber que o provedor deduplicaria um
 * reenvio não é saber que a primeira tentativa chegou.
 */
export const PROVIDER_IDEMPOTENCY_NATIVE = 'native' as const;
export const PROVIDER_IDEMPOTENCY_NONE = 'none' as const;

export type ProviderIdempotencySupport =
  | typeof PROVIDER_IDEMPOTENCY_NATIVE
  | typeof PROVIDER_IDEMPOTENCY_NONE;

/**
 * A capability por (canal, tipo de payload). `satisfies` fecha a porta no
 * compilador: um `payload_type` novo em #630 sem entrada aqui é ERRO DE
 * COMPILAÇÃO, não um default silencioso — e o default silencioso perigoso
 * seria justamente `native`.
 */
const WHATSAPP_IDEMPOTENCY: Record<OutboundPayloadType, ProviderIdempotencySupport> = {
  // `LineOutput.sendText(jid, text, { messageId })` — a ÚNICA primitiva com
  // chave nativa. `status_fallback` sai por ela também (é texto).
  text: PROVIDER_IDEMPOTENCY_NATIVE,
  status_fallback: PROVIDER_IDEMPOTENCY_NATIVE,
  // As quatro sem `messageId` na assinatura. Declarar `native` aqui seria
  // autorizar reenvio de um áudio que o usuário já ouviu.
  audio: PROVIDER_IDEMPOTENCY_NONE,
  document: PROVIDER_IDEMPOTENCY_NONE,
  reaction: PROVIDER_IDEMPOTENCY_NONE,
  interactive_poll: PROVIDER_IDEMPOTENCY_NONE,
} satisfies Record<OutboundPayloadType, ProviderIdempotencySupport>;

const IDEMPOTENCY_BY_CHANNEL: Record<
  OutboundProviderChannel,
  Record<OutboundPayloadType, ProviderIdempotencySupport>
> = {
  whatsapp: WHATSAPP_IDEMPOTENCY,
};

/**
 * A capability declarada para esta (canal, tipo). Total por construção — não
 * existe caminho que devolva `undefined` e caia num default otimista.
 */
export function providerIdempotencySupport(
  channel: OutboundProviderChannel,
  payload_type: OutboundPayloadType,
): ProviderIdempotencySupport {
  return IDEMPOTENCY_BY_CHANNEL[channel][payload_type];
}

/**
 * A chave idempotente deve ser ENTREGUE ao adaptador nesta chamada?
 *
 * Separada de `providerIdempotencySupport` porque são perguntas diferentes:
 * esta é "passe o valor adiante", aquela é "confie nele para autorizar
 * reenvio". Passar uma chave que o adaptador ignora é inofensivo; confiar numa
 * que ele ignora é a duplicata.
 */
export function shouldPassIdempotencyKey(
  channel: OutboundProviderChannel,
  payload_type: OutboundPayloadType,
): boolean {
  return providerIdempotencySupport(channel, payload_type) === PROVIDER_IDEMPOTENCY_NATIVE;
}

// =====================================================================
// 4. NORMALIZAÇÃO DO RESULTADO DO PROVEDOR
// =====================================================================

/**
 * O que o ADAPTADOR observou. Forma bruta, antes da normalização.
 *
 * Discriminada e fechada: o adaptador é obrigado a se posicionar. O que ele
 * NÃO pode fazer é devolver "erro" e deixar o worker adivinhar se a mensagem
 * saiu — essa ambiguidade é a origem do duplo envio, e a razão de
 * `transport_throw` carregar `ambiguous` explicitamente.
 */
export type ProviderAttemptObservation =
  /** O provedor devolveu um identificador de mensagem. Aceitação CONFIRMADA. */
  | { kind: 'accepted_with_id'; provider_message_id: string }
  /**
   * A chamada retornou sem erro e sem identificador. O provedor aceitou o
   * comando — e não há nada que ateste que a mensagem chegou. É o caso
   * `sendText → null` com a linha conectada.
   */
  | { kind: 'accepted_without_id' }
  /** O provedor recusou e a recusa é transitória (rede, indisponibilidade). */
  | { kind: 'rejected_transient'; error_code: string }
  /** O provedor recusou e a recusa é definitiva (payload inválido, bloqueio). */
  | { kind: 'rejected_permanent'; error_code: string }
  /**
   * A chamada lançou pelo TRANSPORTE. `ambiguous: true` ⇒ pode ter sido
   * entregue e ainda assim lançado; `false` ⇒ a falha é comprovadamente
   * anterior ao envio (leitura de arquivo, validação local).
   */
  | { kind: 'transport_throw'; ambiguous: boolean; error_code: string }
  /** O prazo estourou sem resposta. Estado desconhecido por definição. */
  | { kind: 'timeout'; error_code: string }
  /**
   * O `AbortSignal` disparou. `after_send` distingue "abortamos antes de tocar
   * o adaptador" (nada saiu) de "abortamos com a chamada em voo" (desconhecido).
   */
  | { kind: 'aborted'; after_send: boolean; error_code: string };

/**
 * A normalização. Observação bruta ⇒ um dos SETE desfechos de #506.
 *
 * Total, pura e sem default: cada `kind` é tratado, e o `never` no fim faz um
 * `kind` novo virar erro de compilação em vez de cair num ramo genérico. Um
 * default aqui seria o lugar onde "não sei" viraria "deu certo".
 */
export function normalizeProviderOutcome(
  obs: ProviderAttemptObservation,
): OutboundDeliveryOutcome {
  switch (obs.kind) {
    case 'accepted_with_id':
      return 'accepted_confirmed';
    case 'accepted_without_id':
      return 'accepted_unconfirmed';
    case 'rejected_transient':
      return 'rejected_retryable';
    case 'rejected_permanent':
      return 'rejected_terminal';
    case 'transport_throw':
      // Ambíguo ⇒ pode ter chegado. Colapsar isto em `rejected_retryable`
      // seria autorizar reenvio de uma mensagem possivelmente entregue — o
      // defeito exato que a separação em sete categorias existe para nomear.
      return obs.ambiguous ? 'timeout_unknown' : 'rejected_retryable';
    case 'timeout':
      return 'timeout_unknown';
    case 'aborted':
      return obs.after_send ? 'cancelled_after_send_unknown' : 'cancelled_before_send';
    default: {
      const _never: never = obs;
      void _never;
      throw new TypeError('normalizeProviderOutcome: observação fora do contrato');
    }
  }
}

// =====================================================================
// 5. O ESTADO EM QUE A LINHA PARA — NOMEADO HONESTAMENTE
// =====================================================================

/**
 * Desfecho normalizado ⇒ estado durável.
 *
 * A tabela inteira da issue está aqui, e a linha que mais importa é a segunda:
 *
 *   accepted_confirmed          → delivered          (o provedor devolveu id)
 *   accepted_unconfirmed        → delivery_unknown   ← honestidade
 *   rejected_retryable          → retryable
 *   rejected_terminal           → failed_terminal
 *   timeout_unknown             → delivery_unknown
 *   cancelled_before_send       → cancelled
 *   cancelled_after_send_unknown→ delivery_unknown
 *
 * `accepted_unconfirmed → delivery_unknown` é a leitura literal de "não marcar
 * `delivered` só porque a chamada foi iniciada". A chamada retornou; ninguém
 * confirmou nada. Chamar isso de `delivered` seria exatamente o estado
 * desonesto que a issue proíbe — e teria uma consequência operacional concreta:
 * `delivered` sai do radar da reconciliação de #633, então uma resposta que
 * nunca chegou ficaria marcada como entregue para sempre.
 *
 * `delivered` NÃO é o fim do ciclo: o fim é `completed`, e ele só acontece
 * depois de o histórico ser persistido. Ver `delivery.ts`.
 */
const STATUS_BY_OUTCOME: Record<OutboundDeliveryOutcome, OutboundStatusV2> = {
  accepted_confirmed: 'delivered',
  accepted_unconfirmed: 'delivery_unknown',
  rejected_retryable: 'retryable',
  rejected_terminal: 'failed_terminal',
  timeout_unknown: 'delivery_unknown',
  cancelled_before_send: 'cancelled',
  cancelled_after_send_unknown: 'delivery_unknown',
};

export function statusForOutcome(outcome: OutboundDeliveryOutcome): OutboundStatusV2 {
  return STATUS_BY_OUTCOME[outcome];
}

/**
 * Os desfechos que deixam a entrega DESCONHECIDA. É o conjunto que alimenta
 * `maia_outbound_delivery_unknown_total{channel}` e a fila de reconciliação.
 *
 * Derivado de `STATUS_BY_OUTCOME` em vez de escrito à mão: uma lista paralela
 * é a forma mais fácil de as duas divergirem, e a divergência silenciosa aqui
 * seria uma linha desconhecida que ninguém contabiliza.
 */
export const DELIVERY_UNKNOWN_OUTCOMES: readonly OutboundDeliveryOutcome[] = Object.freeze(
  (Object.keys(STATUS_BY_OUTCOME) as OutboundDeliveryOutcome[]).filter(
    (o) => STATUS_BY_OUTCOME[o] === 'delivery_unknown',
  ),
);

export function isDeliveryUnknown(outcome: OutboundDeliveryOutcome): boolean {
  return statusForOutcome(outcome) === 'delivery_unknown';
}

// =====================================================================
// 6. A POLÍTICA DE REENVIO
// =====================================================================

/**
 * Reenviar é seguro a partir deste desfecho?
 *
 * Três respostas, e não duas, porque as razões são diferentes e a triagem
 * também:
 *
 *   `safe`        — a SEMÂNTICA do desfecho EXCLUI entrega anterior. Nada saiu.
 *                   É a lista curta `OUTBOUND_AUTO_RETRYABLE_OUTCOMES` de #630.
 *   `idempotent`  — pode ter saído, MAS o provedor honra a chave idempotente
 *                   para este tipo de payload, então o reenvio carrega o mesmo
 *                   `(remoteJid, fromMe, id)` e o cliente do destinatário o
 *                   trata como a mesma mensagem. Seguro por PROPRIEDADE DO
 *                   PROVEDOR, não por semântica.
 *   `reconcile`   — pode ter saído e o provedor NÃO deduplica. Reenviar é
 *                   duplicar. `delivery_unknown` aciona reconciliação, espera
 *                   ou intervenção — nunca reenvio imediato cego.
 *
 * O caso terminal também devolve `reconcile`: nada a reenviar. Chamar isso de
 * `safe` seria autorizar um loop de reenvio de payload que o provedor recusa
 * por definição.
 */
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile';

export function retrySafety(input: {
  outcome: OutboundDeliveryOutcome;
  channel: OutboundProviderChannel;
  payload_type: OutboundPayloadType;
}): RetrySafety {
  if (isAutoRetryable(input.outcome)) return 'safe';
  if (statusForOutcome(input.outcome) === 'failed_terminal') return 'reconcile';
  if (
    isDeliveryUnknown(input.outcome) &&
    providerIdempotencySupport(input.channel, input.payload_type) ===
      PROVIDER_IDEMPOTENCY_NATIVE
  ) {
    return 'idempotent';
  }
  return 'reconcile';
}

/**
 * O worker pode reenviar SOZINHO, sem passar por reconciliação?
 *
 * Existe como função própria — e não como comparação solta no worker — porque
 * é a única pergunta que autoriza um efeito externo repetido, e um `if` com
 * `!==` invertido num call site seria o duplo envio. Aqui há um lugar só.
 */
export function autoResendAllowed(input: Parameters<typeof retrySafety>[0]): boolean {
  const safety = retrySafety(input);
  return safety === 'safe' || safety === 'idempotent';
}

// =====================================================================
// 7. PERDA DE POSSE DA ENTREGA
// =====================================================================

/** Por que a posse da linha do outbox foi perdida. Label de métrica, fechado. */
export const DELIVERY_LEASE_LOSS_REASONS = [
  /** Uma gravação fenced voltou zero linhas: o token não é mais o vigente. */
  'fence_rejected',
  /** A lease venceu antes de conseguirmos gravar o desfecho. */
  'lease_expired',
  /** O `AbortSignal` do turno dono disparou — a tentativa foi cancelada. */
  'aborted',
] as const;

export type DeliveryLeaseLossReason = (typeof DELIVERY_LEASE_LOSS_REASONS)[number];

/**
 * Uma gravação da tentativa de ENTREGA foi recusada pelo fence.
 *
 * Erro, e não retorno silencioso, pela mesma razão de `StaleClaimError` (#504):
 * quem o recebe está no meio de uma tentativa que precisa PARAR. O ponto do
 * critério de pronto nº 2 é literal — o worker antigo não confirma NEM reenvia
 * — e um `false` ignorável deixaria o pipeline seguir achando que gravou.
 */
export class DeliveryFenceError extends Error {
  readonly code = 'OUTBOUND_DELIVERY_FENCE_REJECTED';
  readonly outbound_id: string;
  readonly operation: string;
  readonly reason: DeliveryLeaseLossReason;

  constructor(args: {
    outbound_id: string;
    operation: string;
    reason: DeliveryLeaseLossReason;
  }) {
    super(
      `outbound_delivery_fence_rejected: a gravação '${args.operation}' da linha ` +
        `${args.outbound_id} foi recusada (${args.reason}) — o claim_token não é mais o ` +
        `vigente. Esta tentativa perdeu a posse e NÃO pode confirmar nem reenviar.`,
    );
    this.name = 'DeliveryFenceError';
    this.outbound_id = args.outbound_id;
    this.operation = args.operation;
    this.reason = args.reason;
  }
}
