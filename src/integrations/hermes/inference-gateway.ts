/**
 * P06 (spec §9.1, §6.10 itens 6-7; K-09; T18) — CONTRATO do gateway de
 * inferência e POLÍTICA de validação de grant, num módulo PURO.
 *
 * ─── A frase que este arquivo torna executável ──────────────────────────────
 *
 * K-09: "o único HTTP novo que o processo filho pode fazer é o gateway de
 * inferência Maia". O §9.1 fecha o contrato dessa rota: campos admitidos
 * enumerados, "não aceitar um passthrough irrestrito", e "parâmetro
 * desconhecido falha com `unsupported_parameter` ANTES de encaminhar".
 *
 * Um campo tolerado aqui não é um detalhe de validação: é superfície de egresso
 * tolerada no único caminho de saída que o filho tem.
 *
 * ─── Por que PURO (mesma razão de `recovery.ts` e `poison-policy.ts`) ───────
 *
 * Sem `db`, sem ALS, sem Redis, sem config de processo, sem métricas e sem
 * relógio ambiente. "Este pedido é admissível?" e "este grant autoriza?" são
 * funções totais das suas entradas — respondíveis sem Postgres, sem boot e sem
 * provider. Se a validação lesse o ambiente, todo teste dela passaria a medir o
 * ambiente do processo de teste em vez da regra.
 *
 * O instante entra por PARÂMETRO (`now`) pelo mesmo motivo: um relógio de
 * processo lido aqui dentro faria o teste de expiração medir o relógio de quem
 * roda o teste, em vez da regra.
 *
 * ─── O que este módulo NÃO é (fatia de contrato) ───────────────────────────
 *
 * Não é servidor, não é rota Fastify, não é repositório e não fala com provider.
 * A hospedagem da rota, as tabelas do §9.2 e o relay ficam para as fatias
 * seguintes do P06. Aqui há tipos, schemas e duas decisões puras.
 *
 * ─── D09 permanece ABERTA, e de propósito ──────────────────────────────────
 *
 * O §9.1 manda "capturar o request real do SHA fixado e fechar JSON Schema
 * explícito". Isso é a decisão pendente D09 (§12.5) e NÃO foi feito: a lista
 * abaixo é a enumeração LITERAL do §9.1, não uma captura do cliente pinado. Em
 * particular o §9.1 diz "`max_tokens` **ou o campo de limite realmente emitido
 * pelo cliente fixado**" — este módulo implementa `max_tokens` porque é o nome
 * que a spec grafa, e um segundo nome só entra com a captura na mão. Inventar
 * aqui o alias de outro SDK seria fechar D09 por suposição.
 *
 * Captura no SHA `5d59366`: `AIAgent._max_tokens_param` troca `max_tokens` por
 * `max_completion_tokens` nas famílias gpt-4o/4.1/5/o1/o3/o4
 * (`utils.model_forces_max_completion_tokens`), e `_swap_developer_role` manda
 * o prompt de sistema como `developer` para gpt-5/codex. Os dois entram; os
 * dois nomes de limite juntos são recusa.
 */
import { z } from 'zod';
import type { EngineRunPhaseV1 } from '@/runtime/engines/contracts.js';

/** Base URL configurada no filho (§9.1). */
export const INFERENCE_GATEWAY_BASE_PATH = '/internal/hermes-inference/v1';

/** A ÚNICA rota do contrato (§9.1). Não há lifecycle, não há `/v1/runs`. */
export const INFERENCE_GATEWAY_COMPLETIONS_PATH =
  `${INFERENCE_GATEWAY_BASE_PATH}/chat/completions` as const;

/**
 * Os campos que o §9.1 admite, e nada além deles.
 *
 * "Isso é GATE de compatibilidade, não licença para incluir todos os campos do
 * SDK" — por isso a lista é fechada e conferida por teste contra o texto da
 * spec, em vez de crescer quando um campo novo aparecer num payload.
 */
export const INFERENCE_ADMITTED_FIELDS = [
  'model',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'stream_options',
] as const;

/**
 * Campos que o corpo NUNCA pode carregar porque seriam autoridade.
 *
 * O §9.1 fecha com "Nenhum campo `user`, `metadata`, session ID ou corpo escolhe
 * tenant", e o §6.10 item 7 repete: o binding "tem que ser instalado pelo
 * supervisor por conexão/credencial de transporte restrita".
 *
 * Eles já cairiam como parâmetro desconhecido — a lista existe para que a
 * recusa seja NOMEADA e testável, do mesmo jeito que `protocol.ts` recusa
 * `api_key` dentro de `inference` em vez de confiar na ausência.
 */
export const INFERENCE_RESERVED_AUTHORITY_FIELDS = [
  'user',
  'metadata',
  'session_id',
  'session',
  'tenant_id',
  'agent_id',
  'pessoa_id',
  'run_id',
  'api_key',
  'authorization',
] as const;

/**
 * Tetos do pedido. São decisões DESTA fatia, derivadas dos limites de
 * transporte já fixados em `protocol.ts` (`WIRE_LIMITS`) — o §9.1 manda
 * "validar tamanho total, número/roles de mensagens ... e teto de contexto" sem
 * dar números. Ficam aqui, nomeados, em vez de espalhados como literais.
 */
export const INFERENCE_LIMITS = {
  /** Mesmo teto de história do `start` (§5.3.4). */
  max_messages: 400,
  /** Linha inteira do pedido, em bytes UTF-8. */
  max_total_bytes: 1_048_576,
  /** Manifest do §4.2 tem teto de 64 tools; o pedido não pode exceder. */
  max_tools: 64,
  /** Teto de saída conferido no gateway E no construtor (§9.3). */
  max_output_tokens: 200_000,
} as const;

/** Erros do §9.1, e somente eles. */
export const INFERENCE_ERROR_STATUS = {
  invalid_request: 400,
  unsupported_parameter: 400,
  invalid_inference_grant: 401,
  run_revoked: 403,
  model_not_allowed: 403,
  tool_surface_mismatch: 403,
  run_not_active: 409,
  payload_too_large: 413,
  budget_exhausted: 429,
  inference_limit_exceeded: 429,
  admission_unavailable: 503,
  provider_unavailable: 503,
} as const satisfies Record<string, number>;

export type InferenceErrorCode = keyof typeof INFERENCE_ERROR_STATUS;

/**
 * Mensagens SANITIZADAS. Nenhuma cita run, tenant, audience, modelo ou instante.
 *
 * O T18 exige "recusa autenticada sanitizada", e o T19 exige recusar "sem
 * revelar se B existe". Uma mensagem que dissesse "grant expirado às 11:59"
 * confirmaria a existência do grant a quem não o apresentou.
 */
const INFERENCE_ERROR_MESSAGE: Record<InferenceErrorCode, string> = {
  invalid_request: 'request is not valid for this endpoint',
  unsupported_parameter: 'request contains a parameter that is not supported',
  invalid_inference_grant: 'inference credential is not valid for this request',
  run_revoked: 'execution authorization was revoked',
  model_not_allowed: 'requested model is not authorized',
  tool_surface_mismatch: 'requested tool surface does not match the approved one',
  run_not_active: 'execution is not accepting inference',
  payload_too_large: 'request exceeds the configured size limits',
  budget_exhausted: 'budget quota is exhausted for this scope',
  inference_limit_exceeded: 'inference quota is exhausted for this execution',
  admission_unavailable: 'admission control is unavailable',
  provider_unavailable: 'upstream provider is unavailable',
};

/**
 * `quota_error` e a palavra "quota" nas duas recusas 429 NÃO são estética. O
 * cliente pinado (SHA 5d59366) tem retry próprio, que não lê `x-should-retry`:
 * `agent/error_classifier.py` classifica um 429 cujo corpo cita `rate_limit`
 * como limite de taxa RETENTÁVEL, e um 429 que fala em cota, sem sinal de
 * janela, como `billing`, terminal. Medido com o classificador real; o spike
 * `hermes-inference-refusals-spike` confere cada código do vocabulário.
 */
const INFERENCE_ERROR_TYPE: Record<InferenceErrorCode, string> = {
  invalid_request: 'invalid_request_error',
  unsupported_parameter: 'invalid_request_error',
  invalid_inference_grant: 'authentication_error',
  run_revoked: 'permission_error',
  model_not_allowed: 'permission_error',
  tool_surface_mismatch: 'permission_error',
  run_not_active: 'conflict_error',
  payload_too_large: 'invalid_request_error',
  budget_exhausted: 'quota_error',
  inference_limit_exceeded: 'quota_error',
  admission_unavailable: 'service_unavailable_error',
  provider_unavailable: 'service_unavailable_error',
};

export interface InferenceWireErrorV1 {
  status: number;
  body: { error: { type: string; code: InferenceErrorCode; message: string } };
}

/**
 * Traduz um código para a resposta de erro de formato compatível (§9.1 item 10).
 *
 * Recebe SÓ o código: não há parâmetro por onde um detalhe interno vazar, e é
 * por isso que as três recusas do T18 são indistinguíveis no fio sem nenhuma
 * disciplina do call site.
 */
export function toWireError(code: InferenceErrorCode): InferenceWireErrorV1 {
  return {
    status: INFERENCE_ERROR_STATUS[code],
    body: {
      error: {
        type: INFERENCE_ERROR_TYPE[code],
        code,
        message: INFERENCE_ERROR_MESSAGE[code],
      },
    },
  };
}

// ─── schema do pedido ───────────────────────────────────────────────────────

const toolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(256),
        /** Sempre STRING no chat completions — o gateway não reinterpreta. */
        arguments: z.string().max(262_144),
      })
      .strict(),
  })
  .strict();

/**
 * Mensagens. `content` é TEXTO: o §9.1 deixa "images, audio, web tools,
 * computer tools, uploads e URLs remotas em conteúdo" fora do piloto textual, e
 * ficar fora tem de ser RECUSA — um bloco ignorado é um bloco encaminhado.
 */
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('developer'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      tool_calls: z.array(toolCallSchema).max(INFERENCE_LIMITS.max_tools).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      tool_call_id: z.string().min(1).max(256),
      content: z.string(),
    })
    .strict(),
]);

const toolSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(256),
        description: z.string().max(4_096).optional(),
        parameters: z.record(z.unknown()),
      })
      .strict(),
  })
  .strict();

const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1).max(256) }).strict(),
    })
    .strict(),
]);

const inferenceRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(messageSchema).min(1).max(INFERENCE_LIMITS.max_messages),
    tools: z.array(toolSchema).max(INFERENCE_LIMITS.max_tools).optional(),
    tool_choice: toolChoiceSchema.optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(INFERENCE_LIMITS.max_output_tokens).optional(),
    max_completion_tokens: z
      .number()
      .int()
      .min(1)
      .max(INFERENCE_LIMITS.max_output_tokens)
      .optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
  })
  .strict();

export type InferenceRequestV1 = z.infer<typeof inferenceRequestSchema>;

export type ParsedInferenceRequest =
  | { kind: 'ok'; request: InferenceRequestV1 }
  | {
      kind: 'invalid';
      code: 'invalid_request' | 'unsupported_parameter' | 'payload_too_large';
      /** CAMINHO do problema. Nunca o valor: o corpo é conteúdo de conversa. */
      field: string;
      reason:
        | 'unknown_parameter'
        | 'reserved_authority'
        | 'schema'
        | 'limit'
        | 'tool_pairing';
    };

const RESERVED = new Set<string>(INFERENCE_RESERVED_AUTHORITY_FIELDS);
const ADMITTED = new Set<string>(INFERENCE_ADMITTED_FIELDS);

/**
 * Valida o pedido do filho. Função TOTAL: todo valor cai em `ok` ou numa recusa
 * com código do §9.1.
 *
 * A ORDEM é parte do contrato:
 *
 *  1. campo desconhecido/de autoridade vem ANTES do schema, porque o §9.1 exige
 *     `unsupported_parameter` especificamente — deixar o `.strict()` do Zod
 *     responder daria `invalid_request` e apagaria a distinção que a spec faz;
 *  2. tamanho vem antes do conteúdo, porque um payload gigante não deve pagar
 *     validação profunda para ser recusado (§9.1 `payload_too_large`).
 */
export function parseInferenceRequest(raw: unknown): ParsedInferenceRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', code: 'invalid_request', field: 'body', reason: 'schema' };
  }
  const body = raw as Record<string, unknown>;

  // 1. Passthrough irrestrito é recusado por NOME, antes de qualquer outra coisa.
  for (const key of Object.keys(body)) {
    if (RESERVED.has(key)) {
      return {
        kind: 'invalid',
        code: 'unsupported_parameter',
        field: key,
        reason: 'reserved_authority',
      };
    }
    if (!ADMITTED.has(key)) {
      return {
        kind: 'invalid',
        code: 'unsupported_parameter',
        field: key,
        reason: 'unknown_parameter',
      };
    }
  }

  // Dois nomes para o mesmo teto: qual valeria é ambíguo, e ambíguo recusa.
  if ('max_tokens' in body && 'max_completion_tokens' in body) {
    return {
      kind: 'invalid',
      code: 'invalid_request',
      field: 'max_completion_tokens',
      reason: 'schema',
    };
  }

  // 2. Limites: recusa determinística, nunca truncamento.
  if (Array.isArray(body.messages) && body.messages.length > INFERENCE_LIMITS.max_messages) {
    return { kind: 'invalid', code: 'payload_too_large', field: 'messages', reason: 'limit' };
  }
  if (Array.isArray(body.tools) && body.tools.length > INFERENCE_LIMITS.max_tools) {
    return { kind: 'invalid', code: 'payload_too_large', field: 'tools', reason: 'limit' };
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
  } catch {
    // Conteúdo fora do domínio JSON (ciclo, BigInt): o schema recusa adiante
    // com diagnóstico melhor do que "too_large".
    bytes = 0;
  }
  if (bytes > INFERENCE_LIMITS.max_total_bytes) {
    return { kind: 'invalid', code: 'payload_too_large', field: 'body', reason: 'limit' };
  }

  // 3. Forma.
  const parsed = inferenceRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'invalid',
      code: 'invalid_request',
      field: issue?.path.join('.') || 'body',
      reason: 'schema',
    };
  }
  // 4. Pares tool_call/tool_result (§9.1 validação 3). Depois do schema porque
  //    precisa dos dados já tipados, e é a única validação CRUZADA entre
  //    mensagens — as anteriores olham uma mensagem de cada vez.
  const orfa = primeiroToolResultOrfao(parsed.data.messages);
  if (orfa !== null) {
    return {
      kind: 'invalid',
      code: 'invalid_request',
      field: `messages.${orfa}.tool_call_id`,
      reason: 'tool_pairing',
    };
  }

  return { kind: 'ok', request: parsed.data };
}

/**
 * Índice do primeiro `tool_result` ÓRFÃO, ou `null` se todos parearem.
 *
 * ─── A regra, e só ela ──────────────────────────────────────────────────────
 *
 * §9.1 validação 3 manda "validar ... pares de tool call/result". Esta função
 * decide UMA direção: todo `tool_call_id` de uma mensagem `role:'tool'` tem de
 * ter sido anunciado por um `tool_calls[].id` de um `assistant` **anterior**.
 *
 * "Anterior" é literal — o conjunto só cresce conforme a varredura avança, de
 * modo que um resultado que aparece ANTES da sua chamada é órfão. Aceitá-lo
 * trataria como pareado um resultado que o modelo não tinha como ter produzido,
 * e o §9.1 fala em "pares", não em "ids que existem em algum lugar do corpo".
 *
 * ─── O que esta função DELIBERADAMENTE não decide ──────────────────────────
 *
 * A direção INVERSA — um `tool_calls[].id` do assistant que fica sem resposta —
 * **não** é decidida aqui, e a omissão é a decisão. Responder a isso exigiria
 * saber se um pedido pode legitimamente carregar uma call ainda pendente, e
 * isso é semântica de sequenciamento do §5.7.4 itens 4-5 (piloto sequencial,
 * no máximo uma chamada pendente por run, e "callback adiantado" que devolve
 * `in_progress` sem executar). A leitura plausível — "o cliente não emitiria
 * nova inferência com uma call em aberto" — é exatamente o tipo de inferência
 * que vira decisão sem procedência, então fica NOMEADA para o P07 resolver
 * quando fixar o sequenciamento, em vez de resolvida aqui por conveniência.
 *
 * Pela mesma régua, id anunciado duas vezes e id respondido duas vezes dentro
 * de um mesmo corpo tocam a regra de redelivery do §5.7.4 item 3 e também não
 * são julgados aqui.
 */
function primeiroToolResultOrfao(messages: InferenceRequestV1['messages']): number | null {
  const anunciadas = new Set<string>();
  let indice = -1;
  for (const m of messages) {
    indice++;
    if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) anunciadas.add(call.id);
      continue;
    }
    if (m.role === 'tool' && !anunciadas.has(m.tool_call_id)) return indice;
  }
  return null;
}

// ─── grant ──────────────────────────────────────────────────────────────────

/**
 * O grant registrado pelo supervisor (§9.1 "Autenticação").
 *
 * O TEXTO do token não aparece aqui, e não pode: o §9.2 exige "unique de hash;
 * nunca texto do token". Quem resolve credencial→grant é o repositório, pela
 * hash; esta política recebe o registro já resolvido.
 */
export interface InferenceGrantV1 {
  run_id: string;
  tenant_id: string;
  agent_id: string;
  /** `bigint` do Postgres como decimal — não cabe em `number`. */
  control_epoch: string;
  /** Público a que o grant foi emitido. Ligado ao run, não escolhido no corpo. */
  audience: string;
  /** Modelo EXATAMENTE aprovado (§9.1 validação 2). */
  model: string;
  manifest_digest: string;
  /** Superfície normalizada do manifest (§9.1 validação 4). */
  allowed_tool_names: readonly string[];
  expires_at: string;
  /** Revogação é monotônica (§9.1). */
  revoked_at: string | null;
  max_inference_calls: number;
}

/**
 * O que o REQUEST apresentou, e nada mais.
 *
 * ─── A ausência é o mecanismo ──────────────────────────────────────────────
 *
 * Não há `pessoa_id`, `conversa_id`, `channel_id` nem `remote_jid`. O T18 exige
 * "nenhuma consulta business" na recusa, e o jeito de garantir isso não é
 * lembrar de não consultar: é o tipo não conseguir expressar o dado, de modo
 * que nenhum call site consiga passá-lo. Mesmo desenho da ausência de
 * `resend_blind` em `RECONCILIATION_DISPOSITIONS`.
 */
export interface InferenceRequestContextV1 {
  presented_audience: string;
  /** Instante do servidor, por PARÂMETRO — ver o cabeçalho do módulo. */
  now: string;
  run_phase: EngineRunPhaseV1;
  calls_so_far: number;
  model_requested: string;
  manifest_digest_effective: string;
  tool_names_requested: readonly string[];
}

export type GrantRefusalCode = Extract<
  InferenceErrorCode,
  | 'invalid_inference_grant'
  | 'run_revoked'
  | 'run_not_active'
  | 'model_not_allowed'
  | 'tool_surface_mismatch'
  | 'inference_limit_exceeded'
>;

/**
 * Motivo INTERNO da recusa, para auditoria.
 *
 * Existe separado do código justamente porque o código é o que viaja e o motivo
 * é o que não viaja: `absent`, `audience_mismatch` e `expired` colapsam no mesmo
 * `invalid_inference_grant` no fio (T18), mas o operador precisa distinguir os
 * três para investigar.
 */
export type GrantAuditReason =
  | 'absent'
  | 'audience_mismatch'
  | 'expired'
  | 'revoked'
  | 'run_not_active'
  | 'model_not_allowed'
  | 'manifest_mismatch'
  | 'tool_not_in_manifest'
  | 'call_cap_reached';

export type GrantValidationV1 =
  | { kind: 'ok' }
  | { kind: 'refused'; code: GrantRefusalCode; audit_reason: GrantAuditReason };

/**
 * `now > expires_at`, com falha FECHADA em instante ilegível.
 *
 * `Date.parse` é determinístico sobre a entrada — não é relógio ambiente. Um
 * `NaN` (formato inesperado) conta como expirado: numa política de
 * autenticação, o desconhecido não autoriza.
 */
function expirou(now: string, expires_at: string): boolean {
  const agora = Date.parse(now);
  const fim = Date.parse(expires_at);
  if (Number.isNaN(agora) || Number.isNaN(fim)) return true;
  return agora > fim;
}

/**
 * Decide se este request está autorizado. Função TOTAL.
 *
 * ─── Por que a AUTENTICAÇÃO vem primeiro ───────────────────────────────────
 *
 * Porque todo código depois dela é uma afirmação sobre o run: `model_not_allowed`
 * diz que existe um modelo aprovado diferente; `run_not_active` diz que o run
 * existe e está noutra fase. Responder qualquer um deles a quem não apresentou
 * credencial válida entrega informação sobre execução alheia — que é o que o
 * T18 ("nenhuma consulta business") e o T19 ("sem revelar se B existe") proíbem.
 *
 * ─── Por que a REVOGAÇÃO vence a fase ──────────────────────────────────────
 *
 * Pela mesma régua com que a evidência de efeito domina a fase em `recovery.ts`:
 * revogação é fato deliberado e monotônico, e o §9.1 a trata como terminal para
 * o run ("recusa de quota/autoridade é terminal para o run"). Deixar a fase
 * decidir antes faria um run revogado responder `run_not_active`, que soa
 * transitório e convida o cliente a repetir.
 */
export function validateInferenceGrant(
  grant: InferenceGrantV1 | null,
  ctx: InferenceRequestContextV1,
): GrantValidationV1 {
  // 1. AUTENTICAÇÃO. Os três casos do T18 colapsam no mesmo código de fio.
  if (grant === null) {
    return { kind: 'refused', code: 'invalid_inference_grant', audit_reason: 'absent' };
  }
  if (ctx.presented_audience.length === 0 || ctx.presented_audience !== grant.audience) {
    return {
      kind: 'refused',
      code: 'invalid_inference_grant',
      audit_reason: 'audience_mismatch',
    };
  }
  if (expirou(ctx.now, grant.expires_at)) {
    return { kind: 'refused', code: 'invalid_inference_grant', audit_reason: 'expired' };
  }

  // 2. Revogação — terminal, e antes da fase.
  if (grant.revoked_at !== null) {
    return { kind: 'refused', code: 'run_revoked', audit_reason: 'revoked' };
  }

  // 3. Estado do run: só `running` libera inferência (§9.1 validação 1).
  if (ctx.run_phase !== 'running') {
    return { kind: 'refused', code: 'run_not_active', audit_reason: 'run_not_active' };
  }

  // 4. Modelo EXATAMENTE igual ao aprovado (§9.1 validação 2).
  if (ctx.model_requested !== grant.model) {
    return { kind: 'refused', code: 'model_not_allowed', audit_reason: 'model_not_allowed' };
  }

  // 5. Superfície: digest do manifest e nomes efetivamente enviados (validação 4).
  if (ctx.manifest_digest_effective !== grant.manifest_digest) {
    return {
      kind: 'refused',
      code: 'tool_surface_mismatch',
      audit_reason: 'manifest_mismatch',
    };
  }
  const permitidas = new Set<string>(grant.allowed_tool_names);
  for (const nome of ctx.tool_names_requested) {
    if (!permitidas.has(nome)) {
      return {
        kind: 'refused',
        code: 'tool_surface_mismatch',
        audit_reason: 'tool_not_in_manifest',
      };
    }
  }

  // 6. Teto de chamadas, que o §9.3 diz incluir retries e auxiliares.
  if (ctx.calls_so_far >= grant.max_inference_calls) {
    return {
      kind: 'refused',
      code: 'inference_limit_exceeded',
      audit_reason: 'call_cap_reached',
    };
  }

  return { kind: 'ok' };
}

// ─── schema da resposta ─────────────────────────────────────────────────────

/**
 * O que o gateway devolve ao filho.
 *
 * O §9.1 item 8 manda "filtrar/validar nomes de tools retornados ANTES de expor
 * ao filho", e o item 9 manda "registrar usage observado". As duas coisas são
 * deste schema: o que não passa por aqui não chega ao processo filho.
 *
 * O modo inicial é NÃO-STREAMING ("o modo inicial pode usar resposta
 * não-streaming para reduzir superfície, se o cliente pinado aceitar"), porque
 * o próprio item 8 avisa que resultado em stream "exige buffering de metadados
 * suficiente para não liberar tool inválida". Validar uma tool que já foi
 * emitida em pedaços é tarde demais.
 */
const responseMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).max(INFERENCE_LIMITS.max_tools).optional(),
  })
  .strict();

const responseChoiceSchema = z
  .object({
    index: z.number().int().min(0),
    message: responseMessageSchema,
    finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable(),
  })
  .strict();

/** Teto `int4` do ledger: contagem maior que isso é uso que não se registra. */
const tokenCount = () => z.number().int().min(0).max(2_147_483_647);

const usageObservedSchema = z
  .object({
    prompt_tokens: tokenCount(),
    completion_tokens: tokenCount(),
    total_tokens: tokenCount(),
  })
  .strict();

const inferenceResponseSchema = z
  .object({
    id: z.string().min(1).max(256),
    object: z.literal('chat.completion'),
    created: z.number().int().min(0),
    model: z.string().min(1).max(256),
    choices: z.array(responseChoiceSchema).min(1).max(8),
    /** OPCIONAL de propósito — ver `InferenceResponseV1.usage`. */
    usage: usageObservedSchema.optional(),
  })
  .strict();

export interface InferenceUsageObservedV1 {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface InferenceResponseV1 {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: z.infer<typeof responseChoiceSchema>[];
  /**
   * `null` quando o provider NÃO reportou uso.
   *
   * Não é um objeto de zeros, e a diferença é a do T59: zeros virariam um
   * evento `reported` de custo zero na contabilidade, apagando uma chamada que
   * pode ter sido cobrada. `null` é o que faz `cost-accounting` marcar
   * `unknown` em vez de liquidar — "erros após envio não equivalem a custo
   * zero" (§9.1 item 9).
   */
  usage: InferenceUsageObservedV1 | null;
}

export type ParsedInferenceResponse =
  | { kind: 'ok'; response: InferenceResponseV1 }
  | {
      kind: 'invalid';
      code: Extract<InferenceErrorCode, 'provider_unavailable' | 'tool_surface_mismatch'>;
      field: string;
    };

/**
 * Valida a resposta do provider antes de expô-la ao filho. Função TOTAL.
 *
 * `allowed_tool_names` é a superfície NORMALIZADA do manifest — a mesma régua
 * do §9.1 validação 4, agora no sentido de volta. Um provider que devolve uma
 * tool fora do manifest não recebe o benefício da dúvida: a call seria admitida
 * pelo broker com um nome que o agente nunca ofereceu.
 *
 * Resposta malformada vira `provider_unavailable` (503) e não `invalid_request`:
 * o pedido do filho estava correto, quem falhou foi o upstream, e devolver 400
 * ensinaria o cliente a corrigir um pedido que não tem defeito.
 */
export function parseInferenceResponse(
  raw: unknown,
  allowed_tool_names: readonly string[],
): ParsedInferenceResponse {
  const parsed = inferenceResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'invalid',
      code: 'provider_unavailable',
      field: issue?.path.join('.') || 'body',
    };
  }

  const permitidas = new Set<string>(allowed_tool_names);
  for (const choice of parsed.data.choices) {
    for (const call of choice.message.tool_calls ?? []) {
      if (!permitidas.has(call.function.name)) {
        // Sem o NOME da tool no diagnóstico: ele volta ao cliente e é
        // superfície do agente.
        return {
          kind: 'invalid',
          code: 'tool_surface_mismatch',
          field: `choices.${choice.index}.message.tool_calls`,
        };
      }
    }
  }

  return {
    kind: 'ok',
    response: {
      id: parsed.data.id,
      object: parsed.data.object,
      created: parsed.data.created,
      model: parsed.data.model,
      choices: parsed.data.choices,
      // Ausência é preservada como ausência. Ver o comentário do campo.
      usage: parsed.data.usage ?? null,
    },
  };
}
