/**
 * Issue #630 (fatia A da épica #506) — contrato PÚBLICO do outbox durável de
 * saída do turno.
 *
 * Módulo irmão de `src/runtime/turns/contract.ts` (#503) e deliberadamente da
 * MESMA natureza: PURO. Sem `db`, sem I/O, sem ALS, sem relógio. Isso o torna
 * unit-testável sem Postgres, permite que o repositório seja a única porta de
 * escrita, e — o que importa mais aqui — torna a derivação das chaves uma
 * FUNÇÃO, no sentido matemático: mesma entrada, mesma saída, para sempre.
 *
 * O que este módulo é:
 *   1. a união discriminada Zod dos payloads de saída suportados;
 *   2. a serialização canônica VERSIONADA e o `payload_hash`;
 *   3. as DUAS identidades — `logical_dedupe_key` e
 *      `provider_idempotency_key` — e a razão de elas serem duas;
 *   4. o vocabulário de estados/desfechos que a migração 121 espelha em CHECK.
 *
 * O que este módulo NÃO é: nada envia, nada persiste, nada agenda. As fatias
 * irmãs (#631 commit transacional, #632 delivery worker, #633 recovery/DLQ,
 * #634 migração dos call sites, #635 multipart) é que ligam a máquina.
 */
import { z } from 'zod';
import { sha256 } from '@/lib/utils.js';

// =====================================================================
// 1. VOCABULÁRIO
// =====================================================================

/**
 * Versão da união E da serialização canônica, JUNTAS e de propósito.
 *
 * `payload_hash` só é comparável dentro de uma versão: mudar a forma canônica
 * sem mudar este número faria uma row antiga parecer adulterada, e mudar a
 * união sem mudar este número faria um payload novo hashear pela regra velha.
 * Persistido em `outbound_messages.payload_version` (migração 121) para que a
 * row diga, sozinha, por qual regra ela deve ser verificada.
 */
export const OUTBOUND_PAYLOAD_VERSION = 1;

/**
 * Tipos de payload suportados. Lista FECHADA; espelha o CHECK
 * `outbound_messages_payload_type_check` da migração 121.
 *
 * ------------------------------------------------------------------
 * O QUE FOI VERIFICADO, EM VEZ DE PRESUMIDO
 * ------------------------------------------------------------------
 * #630 manda incluir `interactive` "só se a plataforma realmente declarar
 * suporte — verifique, não presuma". A fronteira ÚNICA de saída física da
 * plataforma é a interface `LineOutput` em `src/gateway/line-output.ts`, e o
 * acesso direto às primitivas de `baileys.ts`/`presence.ts` fora dela é
 * proibido por lint. O que ela declara:
 *
 *   sendText     → `text`
 *   sendVoice    → `audio`
 *   sendDocument → `document`
 *   sendPoll     → `interactive_poll`   ← a ÚNICA forma real de "interactive"
 *   sendReaction → `reaction`
 *
 * Consequências que valem mais do que a lista:
 *
 * - **`image` e `video` NÃO existem aqui.** Não há primitiva. #506 §Out of
 *   Scope proíbe "implementação de suporte a tipos de mensagem que a
 *   plataforma ainda não declara suportar". Admitir o tipo só no schema
 *   pareceria completude e seria o contrário: uma row que NENHUM delivery
 *   worker consegue entregar é um `pending` eterno — fail-open fantasiado de
 *   cobertura. Quando houver `sendImage`, o tipo entra aqui, no CHECK da
 *   migração e no switch do worker, na mesma PR.
 *
 * - **`interactive` genérico NÃO existe.** Botão e lista não têm primitiva.
 *   O nome é `interactive_poll` — específico — justamente para que ninguém
 *   leia "interactive" e conclua que botões estão cobertos.
 *
 * - `status_fallback` é a saída de fallback/timeout/erro-permitido que
 *   REALMENTE chega ao usuário. Ela existe como tipo próprio porque #506 exige
 *   que fallback e timeout percorram o mesmo outbox; uma resposta interna
 *   "sem envio" NÃO é isto e não vira row (ela tem desfecho próprio no turno,
 *   nunca um `delivered` fingido).
 */
export const OUTBOUND_PAYLOAD_TYPES = [
  'text',
  'audio',
  'document',
  'reaction',
  'interactive_poll',
  'status_fallback',
] as const;

export type OutboundPayloadType = (typeof OUTBOUND_PAYLOAD_TYPES)[number];

/**
 * Tipos deliberadamente NÃO suportados, com o motivo. Não é documentação
 * decorativa: é inventário greppável, e o teste de contrato afirma que a
 * interseção com `OUTBOUND_PAYLOAD_TYPES` é vazia — então acrescentar um tipo
 * sem remover a exclusão (ou vice-versa) reprova no CI em vez de virar um
 * comentário mentiroso.
 */
export const OUTBOUND_PAYLOAD_TYPES_UNSUPPORTED = {
  image:
    'LineOutput (src/gateway/line-output.ts) nao declara sendImage; #506 §Out of Scope proibe implementar tipo que a plataforma ainda nao suporta.',
  video:
    'LineOutput nao declara sendVideo; mesma razao de image.',
  interactive_buttons:
    'LineOutput declara sendPoll e nada mais de interativo; botao/lista nao tem primitiva. A unica forma real de interactive e interactive_poll.',
  interactive_list:
    'Idem interactive_buttons.',
} as const satisfies Record<string, string>;

/**
 * Estados do ciclo de entrega. Espelha `outbound_messages_status_check` (121).
 *
 * Os quatro primeiros são o vocabulário LEGADO da 063 (o caminho síncrono de
 * `src/agent/output-dispatch.ts` continua escrevendo exatamente eles, sem
 * mudança de significado). Os demais são os de #506 §Estados sugeridos.
 *
 * A máquina de transições em si é #632/#633 — aqui está o vocabulário que a
 * migração e o repositório precisam compartilhar para não divergir.
 */
export const OUTBOUND_LEGACY_STATUSES = ['pending', 'sent', 'failed', 'unknown'] as const;

export const OUTBOUND_DURABLE_STATUSES = [
  'claimed',
  'sending',
  'delivered',
  'completed',
  'retryable',
  'delivery_unknown',
  'reconciling',
  'failed_terminal',
  'cancelled',
] as const;

export const OUTBOUND_STATUSES = [
  ...OUTBOUND_LEGACY_STATUSES,
  ...OUTBOUND_DURABLE_STATUSES,
] as const;

export type OutboundStatusV2 = (typeof OUTBOUND_STATUSES)[number];

/**
 * Estados elegíveis para seleção pelo delivery worker. É EXATAMENTE o
 * predicado parcial do índice `idx_outbound_messages_ready` (migração 121):
 * se esta lista e o índice divergirem, a seleção deixa de ser indexada e vira
 * seq scan silencioso na tabela mais quente do caminho de resposta.
 */
export const OUTBOUND_SELECTABLE_STATUSES = ['pending', 'retryable'] as const;

/**
 * Resultado NORMALIZADO do provedor (#506 §Resultado do provider). Espelha
 * `outbound_messages_delivery_outcome_check` (121).
 *
 * A separação que este vocabulário existe para forçar: "o provedor aceitou"
 * não é "o usuário recebeu". `accepted_unconfirmed`, `timeout_unknown` e
 * `cancelled_after_send_unknown` são os estados HONESTOS — retry automático a
 * partir deles é reenvio cego, e a política (#633) é reconciliar.
 */
export const OUTBOUND_DELIVERY_OUTCOMES = [
  'accepted_confirmed',
  'accepted_unconfirmed',
  'rejected_retryable',
  'rejected_terminal',
  'timeout_unknown',
  'cancelled_before_send',
  'cancelled_after_send_unknown',
] as const;

export type OutboundDeliveryOutcome = (typeof OUTBOUND_DELIVERY_OUTCOMES)[number];

/**
 * Desfechos a partir dos quais o retry automático é SEGURO. Deliberadamente
 * curto. Todo o resto exige reconciliação ou é terminal — a decisão fica aqui,
 * declarada, e não espalhada em `if`s do worker.
 */
export const OUTBOUND_AUTO_RETRYABLE_OUTCOMES = [
  'rejected_retryable',
  'cancelled_before_send',
] as const;

export function isAutoRetryable(outcome: OutboundDeliveryOutcome): boolean {
  return (OUTBOUND_AUTO_RETRYABLE_OUTCOMES as readonly string[]).includes(outcome);
}

// =====================================================================
// 2. REFERÊNCIA DE MÍDIA — como o segredo é excluído POR CONSTRUÇÃO
// =====================================================================

/**
 * #506 exige: "blobs grandes devem usar storage/referência, não JSON" e
 * "secrets, tokens e URLs assinadas de longa duração não devem ser
 * persistidos".
 *
 * A forma mais fraca de cumprir isso seria aceitar uma URL e tentar detectar
 * assinatura por regex (`X-Amz-Signature`, `sig=`, `token=`, …). Toda lista
 * dessas é incompleta por construção: basta um provedor novo com outro nome de
 * parâmetro.
 *
 * A forma escolhida é estrutural: **não existe variante que aceite URL.** Uma
 * URL assinada não pode ser persistida porque não há campo onde ela caiba —
 * não porque um validador tentou reconhecê-la. Isso é o mesmo raciocínio do
 * unique PARCIAL da migração 121: preferir "não há entrada possível para o
 * defeito" a "há uma checagem que espero estar completa".
 *
 * As duas formas admitidas:
 *   - `local_path`     — arquivo no filesystem do processo. É o que
 *     `LineOutput.sendDocument(jid, path, …)` consome hoje.
 *   - `storage_object` — bucket + chave de objeto. Sem URL, sem credencial: o
 *     delivery worker resolve o acesso na hora do envio, com credencial de
 *     runtime, e nada disso encosta na row.
 *
 * LIMITAÇÃO CONHECIDA, declarada em vez de escondida: `local_path` NÃO é
 * durável entre processos. Uma row que referencia um temp file sobrevive ao
 * crash; o arquivo, não. Isso é uma decisão de #632 (revalidar MIME/tamanho/
 * existência antes do envio e, na ausência, tratar como falha terminal em vez
 * de enviar outra coisa), e está anotado aqui para que a fatia seguinte não
 * descubra sozinha.
 */
/**
 * `.strict()` em CADA membro, e isto NÃO é redundante com o `.strict()` do
 * payload que contém a mídia: o strict externo só olha as chaves do NÍVEL
 * externo. Sem o strict aqui, um `{kind:'local_path', path, signed_url}` era
 * ACEITO — o zod apenas descartava `signed_url` em silêncio. Descartar é menos
 * grave que persistir, mas "aceitar e ignorar" ainda é fail-open: o chamador
 * acredita que passou a URL, o artefato não a tem, e ninguém é avisado.
 * (Este comentário existe porque o teste de contrato pegou exatamente isso
 * antes do primeiro commit.)
 */
export const mediaRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('local_path'),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('storage_object'),
      bucket: z.string().min(1).max(255),
      object_key: z.string().min(1).max(1024),
    })
    .strict(),
]);

export type MediaRef = z.infer<typeof mediaRefSchema>;

// =====================================================================
// 3. A UNIÃO DISCRIMINADA
// =====================================================================

/**
 * Teto do texto persistido. Generoso para qualquer resposta legítima e ainda
 * ordens de grandeza abaixo do teto de 256 KiB que o CHECK
 * `outbound_messages_payload_json_size_check` (121) impõe ao JSON inteiro —
 * os dois limites são redundantes de propósito, em camadas diferentes.
 */
export const OUTBOUND_TEXT_MAX_CHARS = 16_384;

/**
 * Emojis de reação que a plataforma REALMENTE emite. `LineOutput.sendReaction`
 * é tipado como `emoji: '✅' | '❌'` — a união aqui é a mesma, não um
 * `z.string()` que aceitaria o que o transporte recusa depois.
 */
export const OUTBOUND_REACTION_EMOJIS = ['✅', '❌'] as const;

const textPayloadSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(OUTBOUND_TEXT_MAX_CHARS),
});

const audioPayloadSchema = z.object({
  type: z.literal('audio'),
  /** Voz sintetizada (src/lib/tts.ts) ou áudio pré-existente — sempre por referência. */
  media: mediaRefSchema,
  mimetype: z.string().min(1).max(255),
  /**
   * Texto que gerou o áudio. Persistido porque o retry NÃO pode re-sintetizar
   * com outro conteúdo (#506: "texto renderizado final deve ser o mesmo em
   * retry") e porque é o material do fallback para texto.
   */
  source_text: z.string().min(1).max(OUTBOUND_TEXT_MAX_CHARS),
});

const documentPayloadSchema = z.object({
  type: z.literal('document'),
  media: mediaRefSchema,
  mimetype: z.string().min(1).max(255),
  file_name: z.string().min(1).max(255),
  caption: z.string().max(OUTBOUND_TEXT_MAX_CHARS).optional(),
});

const reactionPayloadSchema = z.object({
  type: z.literal('reaction'),
  /** Mensagem do usuário que está sendo reagida (id do provedor). */
  target_provider_message_id: z.string().min(1).max(255),
  emoji: z.enum(OUTBOUND_REACTION_EMOJIS),
});

const interactivePollPayloadSchema = z.object({
  type: z.literal('interactive_poll'),
  question: z.string().min(1).max(OUTBOUND_TEXT_MAX_CHARS),
  /**
   * `LineOutput.sendPoll` recebe `ReadonlyArray<{ key, label }>`. Mínimo 2
   * (uma enquete de uma opção não é uma escolha) e teto de 12, o limite do
   * WhatsApp.
   */
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().min(1).max(255),
      }),
    )
    .min(2)
    .max(12),
});

const statusFallbackPayloadSchema = z.object({
  type: z.literal('status_fallback'),
  text: z.string().min(1).max(OUTBOUND_TEXT_MAX_CHARS),
  /**
   * Por que esta saída existe. Cardinalidade BAIXA e fechada — é rótulo de
   * métrica/auditoria, então não pode carregar mensagem de erro crua (o vetor
   * por onde payload/PII vazaria para a trilha).
   */
  reason: z.enum(['timeout', 'deadline_exceeded', 'internal_error', 'policy_refusal']),
});

/**
 * A união. Discriminada por `type` — o mesmo literal que vai para
 * `outbound_messages.payload_type`, então a row nunca precisa adivinhar por
 * qual ramo validar. `.strict()` em cada membro: um campo desconhecido é
 * REJEITADO, não ignorado. Isso importa muito aqui — `payload_hash` cobre o
 * que o schema deixa passar, então um campo extra tolerado seria conteúdo
 * fora do hash, e duas saídas diferentes poderiam hashear igual.
 */
export const outboundPayloadSchema = z.discriminatedUnion('type', [
  textPayloadSchema.strict(),
  audioPayloadSchema.strict(),
  documentPayloadSchema.strict(),
  reactionPayloadSchema.strict(),
  interactivePollPayloadSchema.strict(),
  statusFallbackPayloadSchema.strict(),
]);

export type OutboundPayload = z.infer<typeof outboundPayloadSchema>;

/** Valida (fail-closed) e devolve o payload tipado. Lança em payload inválido. */
export function parseOutboundPayload(input: unknown): OutboundPayload {
  return outboundPayloadSchema.parse(input);
}

/** O `payload_type` que a row deve carregar para este payload. */
export function payloadTypeOf(payload: OutboundPayload): OutboundPayloadType {
  return payload.type;
}

// =====================================================================
// 4. SERIALIZAÇÃO CANÔNICA E `payload_hash`
// =====================================================================

/**
 * `JSON.stringify` NÃO é canônico: a ordem das chaves segue a ordem de
 * inserção do objeto. `{a:1,b:2}` e `{b:2,a:1}` são o MESMO payload e
 * produzem strings diferentes — logo hashes diferentes, logo chaves
 * diferentes, logo a mesma saída lógica duplicaria depois de um round-trip
 * pelo banco (o JSONB do Postgres reordena chaves por conta própria) ou de uma
 * refatoração que só trocou a ordem de dois campos no literal.
 *
 * Esta função ordena as chaves de todo objeto recursivamente. Arrays NÃO são
 * ordenados: em `interactive_poll.options` a ordem é semântica (é a ordem que
 * o usuário vê), então reordenar apagaria diferença real.
 *
 * `undefined` é omitido (é ausência, não valor) e `null` é preservado (é
 * valor). Um número não-finito lança em vez de virar `null` silenciosamente.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: numero nao-finito nao tem forma canonica');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalize: tipo nao serializavel (${typeof value})`);
}

/**
 * Prefixo de domínio da serialização canônica do payload. Carrega a versão:
 * se `OUTBOUND_PAYLOAD_VERSION` subir, TODO hash muda, o que é o
 * comportamento certo — um payload v2 não deve poder colidir com um v1.
 */
function payloadCanonicalDomain(): string {
  return `maia.outbound.payload/v${OUTBOUND_PAYLOAD_VERSION}`;
}

/**
 * Serialização canônica VERSIONADA do payload. Exportada porque o teste de
 * contrato e um eventual verificador de integridade precisam da MESMA função
 * que a produção usa — nunca de uma cópia.
 */
export function canonicalizeOutboundPayload(payload: OutboundPayload): string {
  // Revalida antes de hashear: hashear algo que o schema recusaria produziria
  // uma chave para uma saída que nunca poderá ser enviada.
  const parsed = parseOutboundPayload(payload);
  return `${payloadCanonicalDomain()}\n${canonicalize(parsed)}`;
}

/** sha256 hex (minúsculo, 64 chars) da serialização canônica versionada. */
export function computePayloadHash(payload: OutboundPayload): string {
  return sha256(canonicalizeOutboundPayload(payload));
}

// =====================================================================
// 5. AS DUAS IDENTIDADES
// =====================================================================

/**
 * O material canônico das chaves. SÓ campo IMUTÁVEL.
 *
 * `attempt`, `status`, `claimed_by`, `claim_token`, `lease_expires_at`,
 * `next_attempt_at`, `provider_message_id` e qualquer timestamp estão FORA, e
 * a razão é a definição do problema: uma chave de idempotência que muda entre
 * a tentativa 1 e a tentativa 2 não deduplica nada — ela garante o duplo
 * envio que existe para impedir. #506 §Implementation Notes diz isso em uma
 * linha: "não recalcular chave a partir de campos mutáveis".
 */
export interface OutboundLogicalIdentity {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  sequence_in_turn: number;
  payload_hash: string;
}

/**
 * ------------------------------------------------------------------
 * ENQUADRAMENTO POR PREFIXO DE COMPRIMENTO — e por que `:` não serve
 * ------------------------------------------------------------------
 * #506 sugere derivar de `maia:outbound:v1:<tenant>:<agent>:<turn>:<seq>:<hash>`.
 * Concatenar com `:` só é seguro se NENHUM componente puder conter `:`.
 *
 * Verificado, não presumido: `tenants.id` é `TEXT PRIMARY KEY` e `agents.id` é
 * `TEXT PRIMARY KEY` (migração `007_p0_tenants_agents.sql`), **sem CHECK de
 * formato, sem regex, sem restrição de charset**. Um `tenant_id` pode
 * literalmente conter `:`. Então a concatenação ingênua é ambígua de verdade,
 * não em teoria:
 *
 *     tenant='acme:x'  agent='y'    → "…:acme:x:y:…"
 *     tenant='acme'    agent='x:y'  → "…:acme:x:y:…"
 *
 * Dois tenants DIFERENTES, uma chave só. Duas saídas lógicas distintas
 * colidindo é, aqui, uma resposta que some — o unique da 121 recusaria a
 * segunda como se fosse duplicata da primeira. Isso é violação de isolamento
 * de tenant, a invariante nº 1 do projeto.
 *
 * O repo já tem um precedente próximo — `deriveProviderDedupKey`
 * (src/governance/idempotency-effects.ts) usa separador NUL, justificado lá
 * porque aqueles componentes são slugs. NÃO reuso aqui de propósito: NUL
 * depende de "nenhum componente contém NUL", que é outra suposição sobre dado
 * de terceiros. O enquadramento por comprimento não depende de suposição
 * NENHUMA sobre o conteúdo — ele é injetivo para QUALQUER string, inclusive
 * uma que contenha o separador, NUL, ou o próprio prefixo de comprimento.
 *
 * Forma (netstring): `<bytes>:<conteudo>`, com `bytes` em UTF-8 (não em
 * unidades de código UTF-16 — emoji e par surrogate contam bytes reais).
 * Decodificar é inequívoco: leia o número até `:`, consuma exatamente esses
 * bytes. A concatenação de frames é injetiva, então material igual ⇔ tupla
 * igual.
 */
function frame(component: string): string {
  return `${Buffer.byteLength(component, 'utf8')}:${component}`;
}

/** Prefixo de domínio + versão do MATERIAL das chaves (não do payload). */
const KEY_MATERIAL_VERSION = 1;

/**
 * Material canônico compartilhado pelas duas chaves.
 *
 * Ambas saem daqui e se separam só na etapa seguinte, por rótulo de domínio
 * diferente. Isso é o que garante ao mesmo tempo as duas propriedades que
 * #630 exige: elas são DERIVADAS DO MESMO FATO (mesma saída lógica ⇒ as duas
 * estáveis, sempre juntas) e são VALORES INDEPENDENTES (o provedor jamais
 * recebe a chave que é o eixo de unicidade interno da Maia).
 */
function keyMaterial(identity: OutboundLogicalIdentity): string {
  if (!Number.isInteger(identity.sequence_in_turn) || identity.sequence_in_turn < 0) {
    throw new TypeError(
      'outbound key: sequence_in_turn precisa ser inteiro >= 0 — um valor fracionario ou negativo nao tem representacao canonica estavel',
    );
  }
  for (const [name, v] of [
    ['tenant_id', identity.tenant_id],
    ['agent_id', identity.agent_id],
    ['turn_id', identity.turn_id],
    ['payload_hash', identity.payload_hash],
  ] as const) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(
        `outbound key: ${name} ausente. A derivacao FALHA FECHADO — uma chave derivada de escopo incompleto colidiria entre tenants.`,
      );
    }
  }
  return [
    frame(`maia.outbound.key/v${KEY_MATERIAL_VERSION}`),
    frame(identity.tenant_id),
    frame(identity.agent_id),
    frame(identity.turn_id),
    frame(String(identity.sequence_in_turn)),
    frame(identity.payload_hash),
  ].join('');
}

/** Rótulo de domínio da chave lógica (interna à Maia). */
const LOGICAL_KEY_DOMAIN = 'maia.outbound.logical';
/** Rótulo de domínio da chave do provedor. DIFERENTE, de propósito. */
const PROVIDER_KEY_DOMAIN = 'maia.outbound.provider';

/** Prefixo legível da chave lógica — só para triagem em log/psql. */
const LOGICAL_KEY_PREFIX = `mol${KEY_MATERIAL_VERSION}_`;

/**
 * `logical_dedupe_key` — identidade da saída lógica DENTRO da Maia.
 *
 * É um DIGEST, não uma concatenação legível, e isso é requisito e não estética:
 * #630 exige que a chave não exponha tenant, telefone nem conteúdo "em log ou
 * no provedor". Uma chave legível apareceria em toda linha de log estruturado
 * do delivery worker carregando o `tenant_id` em claro. sha256 é
 * pré-imagem-resistente, então a chave é inerte quando logada.
 *
 * Formato: `mol1_` + 64 hex. O prefixo versionado permite reconhecer, num
 * `SELECT` de madrugada, por qual regra aquela row foi chaveada.
 */
export function deriveLogicalDedupeKey(identity: OutboundLogicalIdentity): string {
  const digest = sha256(`${LOGICAL_KEY_DOMAIN}\n${keyMaterial(identity)}`);
  return `${LOGICAL_KEY_PREFIX}${digest}`;
}

/**
 * Formato do id de mensagem do WhatsApp: `3EB0` + hex maiúsculo. É o mesmo que
 * `deriveProviderDedupKey` (src/governance/idempotency-effects.ts) já usa em
 * produção e que o Baileys grava verbatim na key da mensagem
 * (`MiscMessageGenerationOptions.messageId` → `generateWAMessageFromContent`).
 * Reproduzir o formato exato que a plataforma JÁ PROVOU que o transporte
 * aceita é o motivo de não inventar um comprimento novo aqui.
 *
 * BOUND CONHECIDO, herdado e declarado: 18 hex = 72 bits. Pelo limite do
 * aniversário, a chance de duas saídas distintas DE UM MESMO TENANT colidirem
 * é ~n²/2^73; a 1e6 saídas/tenant isso é ~1e-10. Uma colisão significaria o
 * retry de uma saída ser deduplicado contra outra saída do MESMO tenant —
 * o isolamento entre tenants continua intacto, porque tenant e agent entram no
 * material. Alargar o hex é a alavanca se algum dia importar.
 */
const WHATSAPP_MSG_ID_PREFIX = '3EB0';
const WHATSAPP_MSG_ID_HEX_LEN = 18;

/**
 * Canais de egresso com formato próprio de chave. Fechado: um canal novo tem
 * que DECIDIR a sua história de idempotência aqui, não herdar a do WhatsApp
 * por omissão.
 */
export const OUTBOUND_PROVIDER_CHANNELS = ['whatsapp'] as const;
export type OutboundProviderChannel = (typeof OUTBOUND_PROVIDER_CHANNELS)[number];

/**
 * `provider_idempotency_key` — chave estável entregue ao ADAPTADOR.
 *
 * Separação de domínio: o digest é calculado sobre
 * `PROVIDER_KEY_DOMAIN + material`, e não sobre a `logical_dedupe_key`. As
 * duas são funções do mesmo material, mas nenhuma é derivável da outra sem o
 * material — ou seja, quem vê a chave no provedor não obtém a chave de dedupe
 * interna da Maia, e vice-versa.
 *
 * O que o provedor recebe é um digest truncado: nenhum identificador da Maia,
 * do tenant ou do destinatário atravessa a fronteira.
 */
export function deriveProviderIdempotencyKey(
  identity: OutboundLogicalIdentity,
  channel: OutboundProviderChannel,
): string {
  const digest = sha256(`${PROVIDER_KEY_DOMAIN}\n${keyMaterial(identity)}`);
  switch (channel) {
    case 'whatsapp':
      return (
        WHATSAPP_MSG_ID_PREFIX + digest.toUpperCase().slice(0, WHATSAPP_MSG_ID_HEX_LEN)
      );
    default: {
      // Exaustividade: um canal novo decide o proprio formato aqui.
      const _never: never = channel;
      void _never;
      throw new TypeError(`outbound key: canal sem formato de chave declarado (${String(channel)})`);
    }
  }
}

/** As duas identidades de uma saída lógica, derivadas juntas. */
export interface OutboundKeys {
  logical_dedupe_key: string;
  provider_idempotency_key: string;
}

export function deriveOutboundKeys(
  identity: OutboundLogicalIdentity,
  channel: OutboundProviderChannel,
): OutboundKeys {
  return {
    logical_dedupe_key: deriveLogicalDedupeKey(identity),
    provider_idempotency_key: deriveProviderIdempotencyKey(identity, channel),
  };
}

/**
 * Projeção de uma ROW de `outbound_messages` para o material das chaves.
 *
 * Este é o caminho que a #632 percorre: o delivery worker carrega a row por
 * id e precisa das chaves para a tentativa N. Ele existe como função de
 * PRODUÇÃO — e não como algo que cada chamador monta na mão — exatamente para
 * que "a chave não pode depender de campo mutável" seja verificável num só
 * lugar: a assinatura aceita a row INTEIRA, incluindo os campos mutáveis, e o
 * corpo escolhe só os imutáveis.
 *
 * Se alguém, um dia, achar que `attempt` "também identifica a tentativa" e o
 * incluir aqui, a chave deixa de ser estável entre tentativas e o outbox
 * inteiro para de deduplicar. O teste de contrato varia todos os campos
 * mutáveis abaixo e exige que a chave não se mova.
 */
export interface OutboundKeyRowProjection extends OutboundLogicalIdentity {
  // ---- mutáveis: presentes na row, PROIBIDOS no material ----
  attempt?: number;
  status?: string;
  claimed_by?: string | null;
  claim_token?: string | null;
  lease_expires_at?: Date | string | null;
  next_attempt_at?: Date | string | null;
  provider_message_id?: string | null;
  provider_timestamp?: Date | string | null;
  last_error_code?: string | null;
  delivery_outcome?: string | null;
  sent_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export function deriveOutboundKeysFromRow(
  row: OutboundKeyRowProjection,
  channel: OutboundProviderChannel,
): OutboundKeys {
  // A projeção explícita É o contrato. Nada de spread.
  const identity: OutboundLogicalIdentity = {
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    turn_id: row.turn_id,
    sequence_in_turn: row.sequence_in_turn,
    payload_hash: row.payload_hash,
  };
  return deriveOutboundKeys(identity, channel);
}

// =====================================================================
// 6. ARTEFATO PRONTO PARA PERSISTIR
// =====================================================================

/**
 * O tuplo durável completo de uma saída lógica. É o que a #631 grava na mesma
 * transação em que o turno vai para `outbound_pending`, e corresponde 1:1 ao
 * CHECK `outbound_messages_durable_row_complete_check` da migração 121: se
 * este tipo e aquele CHECK divergirem, ou o banco recusa row válida ou aceita
 * row incompleta.
 */
export interface OutboundArtifact {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  sequence_in_turn: number;
  payload_version: number;
  payload_type: OutboundPayloadType;
  payload: OutboundPayload;
  payload_hash: string;
  logical_dedupe_key: string;
  provider_idempotency_key: string;
}

/**
 * Constrói o artefato a partir do payload e do escopo. PURO e determinístico:
 * mesma entrada ⇒ mesmo artefato, byte a byte, hoje e no retry de amanhã.
 *
 * Fail-closed: valida o payload, exige escopo completo (a validação de
 * tenant/agent/turn está em `keyMaterial`, que lança) e só então deriva. Não
 * há caminho que produza um artefato sem as duas chaves.
 */
export function buildOutboundArtifact(input: {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  sequence_in_turn: number;
  payload: OutboundPayload;
  channel: OutboundProviderChannel;
}): OutboundArtifact {
  const payload = parseOutboundPayload(input.payload);
  const payload_hash = computePayloadHash(payload);
  const identity: OutboundLogicalIdentity = {
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    turn_id: input.turn_id,
    sequence_in_turn: input.sequence_in_turn,
    payload_hash,
  };
  const keys = deriveOutboundKeys(identity, input.channel);
  return {
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    turn_id: input.turn_id,
    sequence_in_turn: input.sequence_in_turn,
    payload_version: OUTBOUND_PAYLOAD_VERSION,
    payload_type: payload.type,
    payload,
    payload_hash,
    logical_dedupe_key: keys.logical_dedupe_key,
    provider_idempotency_key: keys.provider_idempotency_key,
  };
}
