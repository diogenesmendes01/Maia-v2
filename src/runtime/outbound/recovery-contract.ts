/**
 * Issue #633 (fatia D da épica #506) — contrato PURO da RECUPERAÇÃO.
 *
 * Terceiro irmão de `contract.ts` (#630) e `delivery-contract.ts` (#632), e da
 * mesma natureza: sem `db`, sem `bullmq`, sem I/O, sem ALS, sem relógio de
 * processo. Aqui mora a decisão que a issue-mãe chama de falha #12 — *o
 * operador rearmar um item incerto e duplicar mensagem para o usuário* — e ela
 * precisa ser testável sem Postgres, num lugar só.
 *
 * ─── A regra que atravessa este arquivo inteiro ─────────────────────────────
 *
 * Reenvio automático só é admissível quando (a) a SEMÂNTICA do desfecho exclui
 * entrega anterior, ou (b) o PROVEDOR honra a chave idempotente para aquele
 * tipo de payload. `delivery_unknown` não satisfaz (a) por definição, e
 * satisfaz (b) só para `text`/`status_fallback` (o Baileys aceita `messageId`
 * em `sendText` e em mais nada — ver `providerIdempotencySupport`).
 *
 * Fora disso a linha vai para reconciliação, espera ou intervenção humana.
 * NUNCA para reenvio imediato cego.
 *
 * Esta decisão já existe em `retrySafety`/`autoResendAllowed` (#632) e NÃO é
 * reimplementada aqui: `reconciliationDisposition` a CHAMA. Duas implementações
 * da mesma política é como elas divergem, e a divergência aqui é a mensagem
 * duplicada no telefone do usuário.
 */
import {
  isDeliveryUnknown,
  autoResendAllowed,
  providerIdempotencySupport,
  PROVIDER_IDEMPOTENCY_NATIVE,
  type ProviderIdempotencySupport,
} from './delivery-contract.js';
import type {
  OutboundDeliveryOutcome,
  OutboundPayloadType,
  OutboundProviderChannel,
} from './contract.js';

// =====================================================================
// 1. LIMITES — política, e por isso constantes e não env vars
// =====================================================================

/**
 * Teto de tentativas de ENTREGA de uma linha antes da DLQ.
 *
 * `attempt` é incrementado pelo claim atômico (`tryClaimDelivery`), então ele
 * conta posses concedidas, não chamadas ao provedor — um takeover de lease
 * vencida também conta, e deve contar: uma linha que teve dez donos e nunca
 * terminou é exatamente o caso que a DLQ existe para tirar de circulação.
 *
 * Doze é o ponto em que o backoff exponencial de `delivery.ts`
 * (`2^attempt * 5s`, teto de 1h) já gastou mais de meio dia de espera. Depois
 * disso, insistir sozinho não é resiliência: é ruído que esconde o incidente.
 *
 * ─── Por que constante e não variável de ambiente ───────────────────────────
 *
 * Uma env var aqui seria a alavanca com que alguém, no meio de um incidente,
 * "resolve" o alarme subindo o teto — e o alarme existe para ser lido, não
 * silenciado. O número é POLÍTICA (quando a plataforma declara desistência), e
 * política que muda por deploy é política que ninguém consegue auditar. Ele
 * está aqui, versionado, num módulo puro e coberto por teste.
 */
export const OUTBOUND_MAX_DELIVERY_ATTEMPTS = 12;

/**
 * Carência antes de a reconciliação TOCAR numa linha incerta.
 *
 * O worker que produziu `delivery_unknown` pode estar vivo: um
 * `accepted_unconfirmed` é gravado por quem ainda respira, e um
 * `cancelled_after_send_unknown` pode ser seguido, segundos depois, do ACK
 * atrasado do provedor. Agir no primeiro tick transformaria latência em
 * duplicata.
 *
 * Cinco minutos é folgado o bastante para cobrir um ACK atrasado do WhatsApp e
 * curto o bastante para o operador não descobrir o problema no dia seguinte.
 */
export const RECONCILIATION_GRACE_MS = 5 * 60_000;

/**
 * Prazo total de uma linha incerta antes de ela virar DLQ.
 *
 * Depois disto, ou já houve reenvio idempotente (e ele também não confirmou),
 * ou a linha esperou intervenção humana que não veio. Manter `delivery_unknown`
 * indefinidamente seria transformar o estado honesto em depósito — e o critério
 * de pronto da issue é literal: "`delivery_unknown` não acumula sem alarme".
 */
export const RECONCILIATION_DEADLINE_MS = 24 * 60 * 60_000;

/**
 * Idade a partir da qual uma linha `delivered` sem histórico é tratada como
 * janela de crash e não como concorrência normal.
 *
 * A janela `delivered -> completed` de #632 é de milissegundos no caminho feliz
 * (uma transação). Um minuto é três ordens de grandeza acima disso, então uma
 * linha que a atravessa está mesmo órfã — o worker morreu entre as duas
 * escritas.
 */
export const DELIVERED_WITHOUT_HISTORY_GRACE_MS = 60_000;

// =====================================================================
// 2. A DECISÃO — o que fazer com uma linha incerta
// =====================================================================

/**
 * O que a reconciliação faz com uma linha `delivery_unknown`/`reconciling`.
 *
 * Quatro valores, e o que NÃO existe é a assinatura da fatia: não há
 * `resend_blind`. Não é omissão nem TODO — é a afirmação de que o tipo não
 * consegue expressar "reenvie sem saber", então nenhum call site consegue
 * pedi-lo.
 */
export const RECONCILIATION_DISPOSITIONS = [
  /** Ainda dentro da carência. Não toca. */
  'await_grace',
  /**
   * Reenvio AUTORIZADO — não por otimismo, mas porque o provedor honra a chave
   * idempotente para este tipo de payload. A linha volta a `retryable`
   * carregando a MESMA `provider_idempotency_key`, então uma eventual primeira
   * entrega e esta segunda colidem em `(remoteJid, fromMe, id)` no cliente do
   * destinatário. Só `text` e `status_fallback` chegam aqui.
   */
  'resend_idempotent',
  /**
   * Reenviar duplicaria. A linha vai para `reconciling` e sai de lá por
   * DECISÃO HUMANA (`rearmOutboundByOperator`), nunca sozinha. É o caminho de
   * `audio`, `document`, `reaction` e `interactive_poll` — os quatro sem chave
   * nativa no Baileys.
   */
  'escalate_manual',
  /** O prazo total venceu, ou o teto de tentativas estourou. DLQ, auditada. */
  'dead_letter',
] as const;

export type ReconciliationDisposition = (typeof RECONCILIATION_DISPOSITIONS)[number];

/**
 * Rótulos de `maia_outbound_reconciliation_total{result}`.
 *
 * São as quatro disposições MAIS `noop` — a linha foi examinada e nada nela
 * pedia ação (por exemplo, uma `delivered` que ganhou histórico entre a leitura
 * e a escrita). Um `result` que só existisse quando algo acontece deixaria
 * "a reconciliação rodou e não achou trabalho" indistinguível de "a
 * reconciliação não rodou", que são incidentes opostos.
 */
export const RECONCILIATION_RESULTS = [
  ...RECONCILIATION_DISPOSITIONS,
  'noop',
  /** A linha `delivered` órfã ganhou o histórico que faltava e foi a `completed`. */
  'history_recovered',
] as const;

export type ReconciliationResult = (typeof RECONCILIATION_RESULTS)[number];

export type ReconciliationInput = {
  /** O desfecho normalizado gravado pela tentativa que deixou a linha incerta. */
  outcome: OutboundDeliveryOutcome;
  channel: OutboundProviderChannel;
  payload_type: OutboundPayloadType;
  /** `outbound_messages.attempt` — posses concedidas, do PostgreSQL. */
  attempt: number;
  /** Idade da linha, em ms, medida contra o relógio do BANCO pelo chamador. */
  age_ms: number;
};

/**
 * A decisão. Pura, total e sem default.
 *
 * ─── A ordem das perguntas é a garantia ─────────────────────────────────────
 *
 *  1. **Prazo total / teto de tentativas primeiro.** Uma linha que já estourou
 *     o orçamento não deve ganhar mais uma chance por ser de um tipo
 *     idempotente: o teto existe justamente para o caso em que o reenvio
 *     idempotente também não confirma, e reordenar isto produziria um loop
 *     infinito de reenvios "seguros".
 *  2. **Carência depois.** Antes dela, nada acontece — nem escalada, para não
 *     encher a fila humana com linhas que o worker vivo ainda vai fechar.
 *  3. **A política de reenvio por último, e delegada.** `autoResendAllowed`
 *     (#632) é a única autoridade; aqui só se traduz `true`/`false` em
 *     disposição. Reimplementar a condição — mesmo "só para deixar explícito" —
 *     criaria duas cópias que divergem no dia em que um canal novo entrar.
 *
 * A guarda `isDeliveryUnknown` no fim não é decorativa: chamar esta função com
 * um desfecho que NÃO é da família desconhecida é erro de programação (a linha
 * não deveria estar na fila de reconciliação), e devolver `escalate_manual` em
 * vez de lançar deixaria o defeito virar uma fila humana silenciosamente
 * crescente.
 */
export function reconciliationDisposition(
  input: ReconciliationInput,
): ReconciliationDisposition {
  if (!isDeliveryUnknown(input.outcome)) {
    throw new TypeError(
      `reconciliationDisposition: '${input.outcome}' não é um desfecho da família ` +
        `desconhecida. Só delivery_unknown entra na fila de reconciliação.`,
    );
  }
  if (
    input.age_ms >= RECONCILIATION_DEADLINE_MS ||
    input.attempt >= OUTBOUND_MAX_DELIVERY_ATTEMPTS
  ) {
    return 'dead_letter';
  }
  if (input.age_ms < RECONCILIATION_GRACE_MS) return 'await_grace';
  return autoResendAllowed({
    outcome: input.outcome,
    channel: input.channel,
    payload_type: input.payload_type,
  })
    ? 'resend_idempotent'
    : 'escalate_manual';
}

/**
 * O teto de tentativas estourou para uma linha que AINDA seria elegível ao
 * worker (`pending`/`retryable`/claim vencido)?
 *
 * Separada de `reconciliationDisposition` porque a pergunta é outra: aqui não
 * há incerteza sobre entrega — a linha simplesmente não conseguiu terminar. A
 * varredura chama esta antes de rearmar o job, e é ela que impede o
 * "rearma → falha → rearma" eterno que a issue lista como risco.
 */
export function attemptBudgetExhausted(attempt: number): boolean {
  return attempt >= OUTBOUND_MAX_DELIVERY_ATTEMPTS;
}

// =====================================================================
// 3. DLQ — por que a linha morreu
// =====================================================================

/** Motivo da ida para `dead_letter`. Vocabulário fechado, label de métrica. */
export const OUTBOUND_DEAD_LETTER_REASONS = [
  /** `attempt >= OUTBOUND_MAX_DELIVERY_ATTEMPTS`. Nada se sabe sobre entrega. */
  'attempt_limit',
  /** A linha incerta atravessou `RECONCILIATION_DEADLINE_MS` sem desfecho. */
  'reconciliation_timeout',
] as const;

export type OutboundDeadLetterReason = (typeof OUTBOUND_DEAD_LETTER_REASONS)[number];

// =====================================================================
// 4. REARMAMENTO MANUAL — a falha #12 da issue-mãe, como tipo
// =====================================================================

/**
 * Estados a partir dos quais um operador pode rearmar.
 *
 * `failed_terminal` está DELIBERADAMENTE fora: o provedor recusou de forma
 * definitiva, e rearmar é pedir a mesma recusa de novo. `completed`, `sent` e
 * companhia também: a mensagem chegou.
 */
export const MANUAL_REARM_SOURCE_STATUSES = [
  'dead_letter',
  'reconciling',
  'delivery_unknown',
] as const;

export type ManualRearmSourceStatus = (typeof MANUAL_REARM_SOURCE_STATUSES)[number];

/** Por que um rearmamento manual foi recusado. Fechado. */
export const MANUAL_REARM_REFUSALS = [
  /** A linha não existe NO ESCOPO. */
  'not_found',
  /** O estado atual não admite rearmamento (ver a lista acima). */
  'status_not_rearmable',
  /**
   * O estado é INCERTO e o operador não reconheceu o risco. É a recusa que a
   * falha #12 pede: rearmar daqui pode entregar a mesma mensagem duas vezes,
   * porque o provedor não deduplica este tipo de payload.
   */
  'duplicate_risk_unacknowledged',
  /** O `reason` da auditoria não foi informado. */
  'reason_missing',
] as const;

export type ManualRearmRefusal = (typeof MANUAL_REARM_REFUSALS)[number];

/**
 * O rearmamento manual pode DUPLICAR a mensagem no telefone do usuário?
 *
 * Duas condições, e as duas precisam ser verdadeiras para o risco existir:
 *
 *  1. a linha carrega um desfecho da família desconhecida — pode ter sido
 *     entregue;
 *  2. o provedor NÃO honra chave idempotente para este `payload_type` — um
 *     segundo envio vira uma segunda mensagem.
 *
 * Quando (2) é falsa, o reenvio carrega a mesma `provider_idempotency_key` e o
 * cliente do destinatário colapsa os dois. Quando (1) é falsa (a linha morreu
 * sem que nada tivesse saído), não há primeira entrega a duplicar.
 *
 * `outcome: null` — uma linha que nunca chegou a registrar desfecho — NÃO é
 * risco de duplicata: sem desfecho não houve chamada ao provedor concluída, e
 * a linha só pode ter morrido por teto de tentativas antes do envio. É a
 * leitura fail-CLOSED assim mesmo, porque um crash com a chamada em voo grava
 * `sending`, não `dead_letter`, e `sending` fora da lista de rearmamento.
 */
export function manualRearmDuplicateRisk(input: {
  outcome: OutboundDeliveryOutcome | null;
  channel: OutboundProviderChannel;
  payload_type: OutboundPayloadType;
}): boolean {
  if (input.outcome === null) return false;
  if (!isDeliveryUnknown(input.outcome)) return false;
  return (
    providerIdempotencySupport(input.channel, input.payload_type) !==
    PROVIDER_IDEMPOTENCY_NATIVE
  );
}

/**
 * A confirmação de risco exigida do operador é suficiente?
 *
 * Fail-CLOSED: sem risco, qualquer chamada passa; COM risco, só passa quem
 * declarou `acknowledge_duplicate_risk: true` EXPLICITAMENTE. Um `undefined`
 * (flag esquecida, campo ausente do JSON) é recusa, e é por isso que a
 * comparação é `=== true` e não um `if (x)`.
 *
 * O `reason` é obrigatório sempre, com ou sem risco: ele vai para a auditoria,
 * e uma intervenção manual sem motivo registrado é uma intervenção que ninguém
 * consegue reconstruir depois. Mesmo contrato do `--reason` de
 * `dlq.ts replay-turn` (#504).
 */
export function manualRearmRefusal(input: {
  status: string;
  reason: string;
  acknowledge_duplicate_risk?: boolean;
  duplicate_risk: boolean;
}): ManualRearmRefusal | null {
  if (!(MANUAL_REARM_SOURCE_STATUSES as readonly string[]).includes(input.status)) {
    return 'status_not_rearmable';
  }
  if (input.reason.trim().length === 0) return 'reason_missing';
  if (input.duplicate_risk && input.acknowledge_duplicate_risk !== true) {
    return 'duplicate_risk_unacknowledged';
  }
  return null;
}

/**
 * A capability, exposta para o operador ver ANTES de decidir.
 *
 * Existe porque a CLI precisa imprimir "este tipo não deduplica" ao lado da
 * linha; sem isso a confirmação de risco vira uma flag que se digita no
 * automático.
 */
export function rearmIdempotencyNote(
  channel: OutboundProviderChannel,
  payload_type: OutboundPayloadType,
): { support: ProviderIdempotencySupport; note: string } {
  const support = providerIdempotencySupport(channel, payload_type);
  return {
    support,
    note:
      support === PROVIDER_IDEMPOTENCY_NATIVE
        ? `o provedor honra a chave idempotente para '${payload_type}': um reenvio colide com a ` +
          `primeira entrega no cliente do destinatário`
        : `o provedor NÃO honra chave idempotente para '${payload_type}': se a primeira ` +
          `tentativa chegou, o reenvio produz uma SEGUNDA mensagem no telefone do usuário`,
  };
}

// =====================================================================
// 5. DIVERGÊNCIA TURNO ↔ OUTBOUND
// =====================================================================

/**
 * Os DOIS sentidos da divergência. Rótulos de
 * `maia_outbound_turn_inconsistency_total{kind}`.
 *
 * A issue exige os dois nominalmente, e a razão é que eles têm causas
 * OPOSTAS:
 *
 *   `turn_pending_without_outbound` — o turno está em `outbound_pending` e não
 *     existe linha do outbox para ele. Como #631 move o turno e insere a linha
 *     na MESMA transação, isto não pode nascer do commit: nasce de um turno
 *     movido por outro caminho (migração de dados, escrita manual) ou de uma
 *     linha apagada. É uma resposta que o turno acha que existe e que ninguém
 *     vai entregar — silêncio para o usuário.
 *
 *   `outbound_without_live_turn` — existe linha do outbox NÃO terminal cujo
 *     turno já é terminal (`completed`/`dead_letter`/`ignored`/`superseded`).
 *     O turno acha que acabou e o outbox ainda vai entregar: é o oposto —
 *     uma mensagem que sai depois de o turno ter sido dado como encerrado.
 *
 * Os dois são OBSERVAÇÃO, não correção automática. Corrigir sozinho qualquer
 * um deles significaria ou inventar uma resposta (sentido 1) ou cancelar uma
 * entrega possivelmente já em voo (sentido 2).
 */
export const OUTBOUND_TURN_INCONSISTENCY_KINDS = [
  'turn_pending_without_outbound',
  'outbound_without_live_turn',
] as const;

export type OutboundTurnInconsistencyKind =
  (typeof OUTBOUND_TURN_INCONSISTENCY_KINDS)[number];

// =====================================================================
// 6. ORIGEM DO REARMAMENTO
// =====================================================================

/**
 * Quem armou o job de entrega. Rótulo `origin` de `maia_outbound_rearm_total`,
 * restrito ao vocabulário já declarado em `ENUM_VALUES.origin`.
 *
 *   `recovery` — a varredura periódica;
 *   `replay`   — um operador, por `rearmOutboundByOperator`.
 *
 * `queue` e `ingress` não aparecem porque nesta fatia NADA enfileira no caminho
 * quente: o commit transacional de #631 continua sem enfileirar (é #634), e
 * fingir uma origem que não existe faria o painel mentir sobre de onde vem o
 * trabalho.
 */
export const OUTBOUND_REARM_ORIGINS = ['recovery', 'replay'] as const;
export type OutboundRearmOrigin = (typeof OUTBOUND_REARM_ORIGINS)[number];
