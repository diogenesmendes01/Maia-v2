/**
 * P02 (spec §5.3.4) — VALIDADORES ESTRITOS DA PORTA DE ENGINE.
 *
 * Os tipos em `./contracts.js` documentam a forma; estes schemas são o que
 * EXECUTA a recusa. Todo objeto é `.strict()`: campo desconhecido reprova o
 * payload em vez de ser ignorado — é assim que `dispatched`, `approved`,
 * `tenant_id` e um `api_key` esquecido deixam de virar autoridade acidental.
 *
 * No fim do arquivo há uma checagem de EQUIVALÊNCIA em tempo de compilação
 * entre cada schema e o tipo correspondente, nos dois sentidos. Sem ela, os
 * dois arquivos divergem silenciosamente na primeira mudança — e o tipo
 * continuaria dizendo uma coisa enquanto a validação faz outra.
 */
import { z } from 'zod';
import type {
  Json,
  EngineKind,
  EnginePinV1,
  EngineRequestV1,
  EngineRunPhaseV1,
  EngineToolCallStateV1,
  EngineCloseReasonV1,
  EngineStopV1,
  EngineTerminalProposalV1,
  EngineToolCallV1,
  EngineToolReplyV1,
  EngineObservationV1,
  EngineStartResultV1,
  EngineRunLocatorV1,
  HostContextSnapshotV1,
  ReportedUsageV1,
} from './contracts.js';

// ─── vocabulários fechados ──────────────────────────────────────────────────

export const ENGINE_KINDS = ['maia_react', 'hermes'] as const;

export const ENGINE_RUN_PHASES = [
  'prepared',
  'submitting',
  'submission_unknown',
  'running',
  'cancelling',
  'reconciling',
  'result_ready',
  'blocked',
  'closed',
] as const;

export const ENGINE_TOOL_CALL_STATES = [
  'received',
  'dispatching',
  'handler_started',
  'completed',
  'denied',
  'approval_required',
  'effect_unknown',
  'cancelled',
] as const;

export const ENGINE_CLOSE_REASONS = [
  'handed_to_outbox',
  'completed_no_reply',
  'safe_to_retry',
  'discarded',
  'manual_resolved',
] as const;

// ─── primitivos ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** `0` ou dígitos sem zero à esquerda: `007` seria duas representações do mesmo valor. */
const DECIMAL_UINT_RE = /^(0|[1-9][0-9]*)$/;

const uuid = () => z.string().regex(UUID_RE, 'uuid inválido');
const sha256 = () => z.string().regex(SHA256_RE, 'sha256 hex inválido');
const decimalUint = () => z.string().regex(DECIMAL_UINT_RE, 'inteiro decimal não negativo');
const isoInstant = () => z.string().datetime({ offset: false });

/**
 * Tipado como `z.ZodType<Json>`, e não `unknown`, de propósito: é isso que faz a
 * inferência do Zod BATER com os tipos de `./contracts.js` e, portanto, faz a
 * checagem de equivalência no fim do arquivo ter valor. Com `unknown` o
 * compilador aceitaria qualquer divergência de `result`/`args` calado.
 */
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

/** Blocos do DTO da Maia (`LLMContentBlock`). O engine remoto não os recebe: o
 * normalizador (`src/integrations/hermes/history.ts`) projeta texto antes. */
const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: jsonValue })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      content: z.string(),
      is_error: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      source: z
        .object({
          type: z.literal('base64'),
          media_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
          data: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

const messageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(contentBlockSchema)]),
  })
  .strict();

const toolSchemaSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string(),
    input_schema: z.record(jsonValue),
  })
  .strict();

// ─── schemas exportados ─────────────────────────────────────────────────────

export const enginePinV1Schema = z
  .object({
    engine: z.enum(ENGINE_KINDS),
    adapter_revision: z.string().min(1).max(128),
    configuration_digest: sha256(),
    protocol_version: z.literal(1),
  })
  .strict();

export const hostContextSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
    turn_id: uuid(),
    pessoa_id: uuid(),
    conversa_id: uuid(),
    channel_id: uuid(),
    representative_message_id: uuid(),
    input_message_ids: z.array(uuid()).min(1),
    stream_key: z.string().min(1).max(512),
    control_id: uuid(),
    control_epoch: decimalUint(),
    remote_jid: z.string().min(1).max(256),
    trace_id: z.string().min(1).max(128),
    active_role_id: uuid().nullable(),
    active_execution_id: uuid().nullable(),
    outbound_prefix: z.string().max(4_096).nullable(),
    allowed_entity_ids: z.array(uuid()),
    allowed_tool_names: z.array(z.string().min(1).max(256)),
    policy_digest: sha256(),
    source_versions: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            id: z.string().min(1).max(256),
            /** `null` = versão indisponível. Não inventar versão (§5.3.4). */
            version: z.string().max(128).nullable(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export const engineRequestV1Schema = z
  .object({
    version: z.literal(1),
    run_id: uuid(),
    request_key: uuid(),
    task: z.literal('reasoner'),
    isolation: z.literal('one_run_no_shared_memory'),
    context: z
      .object({
        system: z.string().min(1),
        messages: z.array(messageSchema).min(1),
        tools: z.array(toolSchemaSchema),
      })
      .strict(),
    limits: z
      .object({
        max_iterations: z.number().int().min(1).max(50),
        max_output_tokens_per_call: z.number().int().min(1).max(200_000),
        max_tool_calls: z.number().int().min(1).max(10_000),
        deadline_at: isoInstant(),
        max_cost_microusd: decimalUint(),
      })
      .strict(),
  })
  .strict();

export const reportedUsageV1Schema = z
  .object({
    input_tokens: z.number().int().min(0).nullable(),
    output_tokens: z.number().int().min(0).nullable(),
    cost_microusd: decimalUint().nullable(),
    source: z.enum(['provider_accounted', 'engine_reported', 'unavailable']),
  })
  .strict();

export const engineStopV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reply'),
      raw_text: z
        .string()
        .min(1)
        .refine((t) => t.trim().length > 0, 'texto vazio após trim não é reply'),
    })
    .strict(),
  z
    .object({ kind: z.literal('no_reply'), reason: z.enum(['empty_final_text', 'iteration_cap']) })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      code: z.enum(['reasoner_failed', 'deadline_exceeded', 'protocol_error']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancelled'),
      reason: z.enum(['ownership_lost', 'operator', 'shutdown']),
    })
    .strict(),
]);

export const engineTerminalProposalV1Schema = z
  .object({
    version: z.literal(1),
    run_id: uuid(),
    request_key: uuid(),
    stop: engineStopV1Schema,
    iterations: z.number().int().min(0).max(1_000),
    observed_tool_call_ids: z
      .array(z.string().min(1).max(256))
      .max(1_000)
      .refine((ids) => new Set(ids).size === ids.length, 'ids repetidos'),
    usage: reportedUsageV1Schema,
  })
  .strict();

export const engineRunLocatorV1Schema = z
  .object({
    run_id: uuid(),
    request_key: uuid(),
    remote_instance_id: z.string().min(1).max(128),
    remote_run_id: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const engineToolCallV1Schema = z
  .object({
    version: z.literal(1),
    run_id: uuid(),
    call_id: z.string().min(1).max(256),
    ordinal: z.number().int().min(0).max(10_000),
    iteration: z.number().int().min(1).max(1_000).nullable(),
    name: z.string().min(1).max(256),
    args: jsonValue,
  })
  .strict();

export const engineToolReplyV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('result'),
      call_id: z.string().min(1).max(256),
      result: jsonValue,
      is_error: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('in_progress'),
      call_id: z.string().min(1).max(256),
      retry_after_ms: z.number().int().min(1).max(60_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('refused'),
      call_id: z.string().min(1).max(256),
      code: z.enum([
        'run_not_authorized',
        'tool_not_allowed',
        'payload_conflict',
        'budget_exhausted',
        'effect_unknown',
        'protocol_error',
      ]),
    })
    .strict(),
]);

export const engineStartResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), remote_run_id: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal('rejected'),
      /**
       * Literal `true`: “rejeitado” só existe COM prova de não-aceite. Um
       * `false` aqui seria um estado sem nome — o nome dele é `unknown`.
       */
      definitely_not_accepted: z.literal(true),
      code: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ kind: z.literal('unknown'), code: z.string().min(1).max(64) }).strict(),
]);

export const engineObservationV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running'), remote_run_id: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal('terminal'),
      remote_run_id: z.string().min(1).max(512),
      proposal: engineTerminalProposalV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('not_found'),
      proof: z.enum(['definitely_not_accepted', 'inconclusive']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      code: z.enum(['timeout', 'transport', 'unauthorized', 'unsupported']),
    })
    .strict(),
]);

// ─── equivalência schema ↔ tipo, conferida pelo compilador ──────────────────

/** Falha de compilação se um lado ganhar ou perder campo em relação ao outro. */
type Exato<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _pin: Exato<z.infer<typeof enginePinV1Schema>, EnginePinV1> = true;
const _snapshot: Exato<z.infer<typeof hostContextSnapshotV1Schema>, HostContextSnapshotV1> = true;
const _usage: Exato<z.infer<typeof reportedUsageV1Schema>, ReportedUsageV1> = true;
const _stop: Exato<z.infer<typeof engineStopV1Schema>, EngineStopV1> = true;
const _proposal: Exato<
  z.infer<typeof engineTerminalProposalV1Schema>,
  EngineTerminalProposalV1
> = true;
const _locator: Exato<z.infer<typeof engineRunLocatorV1Schema>, EngineRunLocatorV1> = true;
const _reply: Exato<z.infer<typeof engineToolReplyV1Schema>, EngineToolReplyV1> = true;
const _start: Exato<z.infer<typeof engineStartResultV1Schema>, EngineStartResultV1> = true;
const _observation: Exato<z.infer<typeof engineObservationV1Schema>, EngineObservationV1> = true;
const _phases: Exato<(typeof ENGINE_RUN_PHASES)[number], EngineRunPhaseV1> = true;
const _states: Exato<(typeof ENGINE_TOOL_CALL_STATES)[number], EngineToolCallStateV1> = true;
const _closes: Exato<(typeof ENGINE_CLOSE_REASONS)[number], EngineCloseReasonV1> = true;
const _kinds: Exato<(typeof ENGINE_KINDS)[number], EngineKind> = true;

/**
 * `EngineRequestV1.context.messages` e `EngineToolCallV1.args` usam tipos da
 * Maia (`LLMMessage`) e `Json`, cuja inferência do Zod é estruturalmente
 * equivalente mas não idêntica ao alias; a conferência aqui é de
 * ATRIBUIBILIDADE num sentido, que é o que importa para o produtor.
 */
const _request = (r: z.infer<typeof engineRequestV1Schema>): EngineRequestV1 =>
  r as EngineRequestV1;
const _call = (c: z.infer<typeof engineToolCallV1Schema>): EngineToolCallV1 =>
  c as EngineToolCallV1;

void [
  _pin,
  _snapshot,
  _usage,
  _stop,
  _proposal,
  _locator,
  _reply,
  _start,
  _observation,
  _phases,
  _states,
  _closes,
  _kinds,
  _request,
  _call,
];
