/**
 * P00 (spec §4.1, §6.4.2, §6.8) — CONTRATO WIRE `maia.hermes.worker.v1`.
 *
 * O transporte da V1 é um pipe privado herdado pelo filho Python, em NDJSON
 * UTF-8 (um objeto por linha). Este módulo é a única fronteira que transforma
 * bytes desse pipe em estruturas da Maia — e a única que transforma estruturas
 * da Maia em bytes para o filho.
 *
 * ─── O que este módulo NÃO é ────────────────────────────────────────────────
 *
 * Não é autorização. A autenticação do canal é a POSSE do pipe criado pelo
 * supervisor (§4.1, §6.3): o broker resolve o contexto pelo objeto de conexão
 * já vinculado a um `RunBinding`, nunca por um campo do frame. Os `run_id`
 * repetidos nos frames são CORRELAÇÃO: comparados e recusados em divergência,
 * jamais usados para escolher tenant, pessoa ou execução.
 *
 * Por isso o schema é fechado nos dois sentidos: qualquer chave desconhecida
 * recusa o frame. Um campo ignorado hoje é um campo lido amanhã, e é assim que
 * `tenant_id`/`approved` vindos do modelo viram autoridade por acidente
 * (§5.3.3 lista explicitamente o que o wire precisa rejeitar).
 *
 * ─── Identidade da chamada ──────────────────────────────────────────────────
 *
 * O frame traz `call_seq` (contador monotônico do cliente IPC, por run, a
 * partir de ZERO). `call_id` é DERIVADO pela Maia (`run_id:call_seq`) e o
 * `ordinal` do journal é o próprio `call_seq` (§4.1). O worker não escolhe id
 * de chamada, não escolhe run e não recebe poder de renomear nenhum dos dois.
 *
 * ─── Segredos ───────────────────────────────────────────────────────────────
 *
 * O `start` carrega binding NÃO SECRETO. A credencial curta de inferência
 * (§9.1) chega ao filho por variável de ambiente allowlisted no spawn, nunca
 * por frame, prompt, schema ou resultado — e o schema abaixo RECUSA
 * `api_key`/`token`/`authorization` dentro de `inference` para que uma
 * regressão futura falhe em teste em vez de vazar em produção.
 */
import { z } from 'zod';
import { canonicalByteLength } from './canonical-json.js';

export const HERMES_WORKER_PROTOCOL_VERSION = 'maia.hermes.worker.v1' as const;

/**
 * Tetos do transporte (§5.3.4). São decisões desta V1, derivadas dos limites da
 * spec (pedido/contexto até 1 MiB; argumentos/resultado até 256 KiB), e valem
 * como RECUSA determinística — nunca truncamento.
 */
export const WIRE_LIMITS = {
  /** Linha NDJSON inteira, em bytes UTF-8. Cobre o `start` com contexto. */
  max_frame_bytes: 1_048_576,
  /** `args` de uma tool e `result` devolvido a ela. */
  max_tool_payload_bytes: 262_144,
  /** Profundidade de aninhamento aceita antes de olhar o schema. */
  max_json_depth: 32,
  /** Teto de `call_seq` por run — o piloto é sequencial e curto. */
  max_call_seq: 10_000,
  /** Mensagens de histórico projetadas no `start`. */
  max_history_messages: 400,
  /** Texto candidato e textos de contexto. */
  max_text_chars: 262_144,
  /** Código de erro fechado (§5.3.4). */
  max_error_code_chars: 64,
} as const;

export type WireErrorCode =
  | 'not_json'
  | 'forbidden_key'
  | 'too_large'
  | 'too_deep'
  | 'protocol_mismatch'
  | 'unknown_type'
  | 'wrong_direction'
  | 'schema';

export type ParsedFrame<T> =
  | { kind: 'ok'; frame: T }
  | { kind: 'invalid'; code: WireErrorCode; detail: string };

// ─── primitivos ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
/** Inteiro decimal não negativo como STRING — dinheiro nunca em float (§5.3.1). */
const DECIMAL_UINT_RE = /^(0|[1-9][0-9]*)$/;

const uuid = () => z.string().regex(UUID_RE, 'uuid inválido');
const sha256 = () => z.string().regex(SHA256_RE, 'sha256 hex inválido');
const isoInstant = () => z.string().datetime({ offset: false });
const shortText = (max: number) => z.string().min(1).max(max);

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

const jsonObject = z.record(jsonValue);

const callSeq = () => z.number().int().min(0).max(WIRE_LIMITS.max_call_seq);

// ─── worker → Maia ──────────────────────────────────────────────────────────

const readyFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('ready'),
    run_id: uuid(),
    worker: z
      .object({
        bridge_revision: shortText(128),
        hermes_sha: z.string().regex(SHA1_RE, 'sha do checkout Hermes inválido'),
        python_version: shortText(64),
      })
      .strict(),
    /** Superfície EFETIVA observada no agente construído (§6.6 invariante 2). */
    effective_tool_names: z.array(shortText(256)).max(128),
    tool_schema_digest: sha256(),
  })
  .strict();

const toolRequestFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('tool.request'),
    run_id: uuid(),
    call_seq: callSeq(),
    name: shortText(256),
    args: jsonObject,
    /** Diagnóstico apenas: a sessão Hermes pode rotacionar por compressão. */
    observed_session_id: z.string().max(256).nullable(),
  })
  .strict();

const progressFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('progress'),
    run_id: uuid(),
    seq: z.number().int().min(0).max(100_000),
    event: z.enum(['tool_start', 'tool_complete', 'iteration_started']),
    call_seq: callSeq().nullable(),
    tool_name: z.string().max(256).nullable(),
  })
  .strict();

const cancelAckFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('cancel_ack'),
    run_id: uuid(),
    received_at: isoInstant(),
  })
  .strict();

/**
 * Desfecho deliberativo (§5.3.1 `EngineStopV1`). `reply` exige texto não vazio
 * DEPOIS de `trim`: vazio é `no_reply/empty_final_text`, nunca "anúncio
 * sozinho" (§5.3.4).
 */
const stopSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reply'),
      raw_text: z
        .string()
        .min(1)
        .max(WIRE_LIMITS.max_text_chars)
        .refine((t) => t.trim().length > 0, 'texto vazio após trim não é reply'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('no_reply'),
      reason: z.enum(['empty_final_text', 'iteration_cap']),
    })
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

const resultFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('result'),
    run_id: uuid(),
    request_key: uuid(),
    stop: stopSchema,
    iterations: z.number().int().min(0).max(1_000),
    /**
     * O que o worker AFIRMA ter chamado. Não é evidência: o assembler compara
     * com o journal da Maia e recusa divergência (§5.3.4).
     */
    observed_tool_call_seqs: z.array(callSeq()).max(256),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).nullable(),
        output_tokens: z.number().int().min(0).nullable(),
        cost_microusd: z.string().regex(DECIMAL_UINT_RE).nullable(),
        source: z.enum(['provider_accounted', 'engine_reported', 'unavailable']),
      })
      .strict(),
    /** Rota/telemetria observada; confrontada com a seleção autorizada (§6.8). */
    observed: z
      .object({
        model: z.string().max(256).nullable(),
        provider: z.string().max(64).nullable(),
        final_session_id: z.string().max(256).nullable(),
        turn_exit_reason: z.string().max(WIRE_LIMITS.max_error_code_chars).nullable(),
        failure_code: z.string().max(WIRE_LIMITS.max_error_code_chars).nullable(),
      })
      .strict(),
  })
  .strict();

// ─── Maia → worker ──────────────────────────────────────────────────────────

/**
 * Projeção do manifest para o FILHO: só o necessário para registrar as tools.
 * O manifest completo do §4.2 (classes de efeito, alvos de autorização, limites
 * monetários, refs de política) é dado interno da Maia e NÃO desce ao worker —
 * o que desce é o digest, em `binding.manifest_digest`, para o `ready` provar
 * que a superfície registrada corresponde ao que a Maia compilou.
 */
const manifestProjectionSchema = z
  .object({
    schema: z.literal('maia-hermes-runtime-manifest/v1'),
    tools: z
      .array(
        z
          .object({
            name: shortText(256),
            input_schema: jsonObject,
            result_limit_chars: z.number().int().min(1).max(1_000_000),
          })
          .strict(),
      )
      .max(64),
    result_limit_chars: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const startFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('start'),
    run_id: uuid(),
    request_key: uuid(),
    binding: z
      .object({
        /** `execution_id` é o MESMO uuid do run (§4.1). */
        execution_id: uuid(),
        task_id: shortText(128),
        initial_session_id: shortText(128),
        manifest_digest: sha256(),
        mode: z.enum(['live', 'shadow']),
      })
      .strict(),
    manifest: manifestProjectionSchema,
    context: z
      .object({
        system: z.string().min(1).max(WIRE_LIMITS.max_text_chars),
        user_message: z.string().min(1).max(WIRE_LIMITS.max_text_chars),
        /**
         * Histórico TEXTUAL canônico (§4.1 "Compatibilidade de contexto"): na
         * primeira coorte não viajam blocos de tool_use/tool_result antigos —
         * pares sem id válido no motor de destino seriam reconstruídos
         * adivinhando correlação.
         */
        history: z
          .array(
            z
              .object({
                role: z.enum(['user', 'assistant']),
                text: z.string().max(WIRE_LIMITS.max_text_chars),
              })
              .strict(),
          )
          .max(WIRE_LIMITS.max_history_messages),
      })
      .strict(),
    limits: z
      .object({
        max_iterations: z.number().int().min(1).max(50),
        max_output_tokens_per_call: z.number().int().min(1).max(200_000),
        max_tool_calls: z.number().int().min(1).max(WIRE_LIMITS.max_call_seq),
        max_inference_calls: z.number().int().min(1).max(1_000),
        run_budget_seconds: z.number().int().min(1).max(3_600),
        deadline_at: isoInstant(),
      })
      .strict(),
    inference: z
      .object({
        base_url: z
          .string()
          .url()
          .refine(
            (u) => u.startsWith('http://') || u.startsWith('https://'),
            'apenas http(s)',
          )
          .refine((u) => !u.includes('@'), 'userinfo não é permitido na base_url'),
        model: shortText(256),
        provider: shortText(64),
        api_mode: z.literal('chat_completions'),
      })
      .strict(),
  })
  .strict();

const toolResultFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('tool.result'),
    run_id: uuid(),
    call_seq: callSeq(),
    outcome: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('result'),
          result: jsonValue,
          is_error: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('in_progress'),
          retry_after_ms: z.number().int().min(1).max(60_000),
        })
        .strict(),
      z
        .object({
          kind: z.literal('refused'),
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
    ]),
  })
  .strict();

const cancelFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('cancel'),
    run_id: uuid(),
    /** Categoria fechada. Texto do cliente NUNCA vira instrução de controle. */
    reason: z.enum(['ownership_lost', 'operator', 'deadline', 'shutdown', 'policy']),
    grace_deadline_at: isoInstant(),
  })
  .strict();

const resultAckFrameSchema = z
  .object({
    protocol: z.literal(HERMES_WORKER_PROTOCOL_VERSION),
    type: z.literal('result_ack'),
    run_id: uuid(),
    terminal_digest: sha256(),
  })
  .strict();

// ─── tipos exportados ───────────────────────────────────────────────────────

export type ReadyFrame = z.infer<typeof readyFrameSchema>;
export type ToolRequestFrame = z.infer<typeof toolRequestFrameSchema>;
export type ProgressFrame = z.infer<typeof progressFrameSchema>;
export type CancelAckFrame = z.infer<typeof cancelAckFrameSchema>;
export type ResultFrame = z.infer<typeof resultFrameSchema>;
export type WorkerToMaiaFrame =
  | ReadyFrame
  | ToolRequestFrame
  | ProgressFrame
  | CancelAckFrame
  | ResultFrame;

export type StartFrame = z.infer<typeof startFrameSchema>;
export type ToolResultFrame = z.infer<typeof toolResultFrameSchema>;
export type CancelFrame = z.infer<typeof cancelFrameSchema>;
export type ResultAckFrame = z.infer<typeof resultAckFrameSchema>;
export type MaiaToWorkerFrame = StartFrame | ToolResultFrame | CancelFrame | ResultAckFrame;

export type EngineStopWire = z.infer<typeof stopSchema>;

const WORKER_TO_MAIA_SCHEMAS = {
  ready: readyFrameSchema,
  'tool.request': toolRequestFrameSchema,
  progress: progressFrameSchema,
  cancel_ack: cancelAckFrameSchema,
  result: resultFrameSchema,
} as const;

const MAIA_TO_WORKER_SCHEMAS = {
  start: startFrameSchema,
  'tool.result': toolResultFrameSchema,
  cancel: cancelFrameSchema,
  result_ack: resultAckFrameSchema,
} as const;

export const WORKER_TO_MAIA_TYPES = Object.keys(WORKER_TO_MAIA_SCHEMAS) as Array<
  keyof typeof WORKER_TO_MAIA_SCHEMAS
>;
export const MAIA_TO_WORKER_TYPES = Object.keys(MAIA_TO_WORKER_SCHEMAS) as Array<
  keyof typeof MAIA_TO_WORKER_SCHEMAS
>;

// ─── parsing ────────────────────────────────────────────────────────────────

class ForbiddenKeyError extends Error {
  constructor(readonly key: string) {
    super(`chave proibida no frame: ${key}`);
  }
}

const FORBIDDEN_WIRE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseJsonLine(line: string): ParsedFrame<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(line, (key, val) => {
      if (FORBIDDEN_WIRE_KEYS.has(key)) throw new ForbiddenKeyError(key);
      return val;
    }) as unknown;
  } catch (err) {
    if (err instanceof ForbiddenKeyError) {
      return { kind: 'invalid', code: 'forbidden_key', detail: err.key };
    }
    return { kind: 'invalid', code: 'not_json', detail: 'linha não é JSON válido' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', code: 'not_json', detail: 'frame precisa ser objeto JSON' };
  }
  return { kind: 'ok', frame: value as Record<string, unknown> };
}

function exceedsDepth(value: unknown, max: number, depth = 0): boolean {
  if (depth > max) return true;
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((v) => exceedsDepth(v, max, depth + 1));
  }
  return Object.values(value as Record<string, unknown>).some((v) =>
    exceedsDepth(v, max, depth + 1),
  );
}

function payloadTooLarge(frame: Record<string, unknown>): string | null {
  const type = frame.type;
  try {
    if (type === 'tool.request' && frame.args !== undefined) {
      if (canonicalByteLength(frame.args) > WIRE_LIMITS.max_tool_payload_bytes) return 'args';
    }
    if (type === 'tool.result') {
      const outcome = frame.outcome as { kind?: unknown; result?: unknown } | undefined;
      if (outcome && outcome.kind === 'result' && outcome.result !== undefined) {
        if (canonicalByteLength(outcome.result) > WIRE_LIMITS.max_tool_payload_bytes) {
          return 'outcome.result';
        }
      }
    }
  } catch {
    // Conteúdo fora do domínio JSON canônico: o schema recusa adiante com
    // detalhe melhor do que "too_large".
    return null;
  }
  return null;
}

type Direction = 'worker_to_maia' | 'maia_to_worker';

function parseFrame(
  raw: string | Buffer,
  direction: Direction,
): ParsedFrame<WorkerToMaiaFrame | MaiaToWorkerFrame> {
  const line = (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\r?\n$/, '');
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > WIRE_LIMITS.max_frame_bytes) {
    return {
      kind: 'invalid',
      code: 'too_large',
      detail: `frame com ${bytes} bytes acima do teto ${WIRE_LIMITS.max_frame_bytes}`,
    };
  }
  if (line.trim().length === 0) {
    return { kind: 'invalid', code: 'not_json', detail: 'linha vazia' };
  }

  const parsed = parseJsonLine(line);
  if (parsed.kind === 'invalid') return parsed;
  const frame = parsed.frame;

  if (exceedsDepth(frame, WIRE_LIMITS.max_json_depth)) {
    return { kind: 'invalid', code: 'too_deep', detail: 'aninhamento acima do limite' };
  }

  if (frame.protocol !== HERMES_WORKER_PROTOCOL_VERSION) {
    return {
      kind: 'invalid',
      code: 'protocol_mismatch',
      detail: `protocolo ${String(frame.protocol)} não é ${HERMES_WORKER_PROTOCOL_VERSION}`,
    };
  }

  const type = frame.type;
  if (typeof type !== 'string') {
    return { kind: 'invalid', code: 'unknown_type', detail: 'type ausente' };
  }

  const own = direction === 'worker_to_maia' ? WORKER_TO_MAIA_SCHEMAS : MAIA_TO_WORKER_SCHEMAS;
  const other = direction === 'worker_to_maia' ? MAIA_TO_WORKER_SCHEMAS : WORKER_TO_MAIA_SCHEMAS;

  if (!(type in own)) {
    if (type in other) {
      return {
        kind: 'invalid',
        code: 'wrong_direction',
        detail: `frame "${type}" não trafega nesse sentido`,
      };
    }
    return { kind: 'invalid', code: 'unknown_type', detail: `tipo desconhecido: ${type}` };
  }

  const oversized = payloadTooLarge(frame);
  if (oversized) {
    return {
      kind: 'invalid',
      code: 'too_large',
      detail: `${oversized} acima do teto ${WIRE_LIMITS.max_tool_payload_bytes} bytes`,
    };
  }

  const schema = (own as Record<string, z.ZodTypeAny | undefined>)[type];
  if (!schema) {
    // Inalcançável pelo `type in own` acima; mantido porque o índice de objeto é
    // tipado como possivelmente ausente e um `!` aqui seria uma promessa que o
    // compilador não pode conferir.
    return { kind: 'invalid', code: 'unknown_type', detail: `tipo sem schema: ${type}` };
  }
  const result = schema.safeParse(frame);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      kind: 'invalid',
      code: 'schema',
      // Só o CAMINHO e o código do problema: a mensagem do Zod pode ecoar o
      // valor recebido, que aqui é conteúdo de conversa.
      detail: `${issue?.path.join('.') || 'frame'}: ${issue?.code ?? 'invalid'}`,
    };
  }
  return { kind: 'ok', frame: result.data as WorkerToMaiaFrame | MaiaToWorkerFrame };
}

/** Lê um frame emitido pelo worker (o que a Maia recebe pelo pipe). */
export function parseWorkerFrame(raw: string | Buffer): ParsedFrame<WorkerToMaiaFrame> {
  return parseFrame(raw, 'worker_to_maia') as ParsedFrame<WorkerToMaiaFrame>;
}

/** Lê um frame emitido pela Maia (o que o worker recebe). Usado em teste/fixture. */
export function parseMaiaFrame(raw: string | Buffer): ParsedFrame<MaiaToWorkerFrame> {
  return parseFrame(raw, 'maia_to_worker') as ParsedFrame<MaiaToWorkerFrame>;
}

// ─── serialização ───────────────────────────────────────────────────────────

export class WireLimitError extends Error {
  constructor(readonly what: string, readonly bytes: number, readonly limit: number) {
    super(`frame recusado: ${what} com ${bytes} bytes acima do limite de ${limit} bytes`);
    this.name = 'WireLimitError';
  }
}

/**
 * Emite UMA linha NDJSON. Recusa (lança) em vez de truncar: truncar um frame é
 * transformar um payload recusável num payload plausível.
 */
export function serializeFrame(frame: MaiaToWorkerFrame | WorkerToMaiaFrame): string {
  const type = (frame as { type?: unknown }).type;
  const schema =
    typeof type === 'string'
      ? ((MAIA_TO_WORKER_SCHEMAS as Record<string, z.ZodTypeAny>)[type] ??
        (WORKER_TO_MAIA_SCHEMAS as Record<string, z.ZodTypeAny>)[type])
      : undefined;
  if (!schema) throw new Error(`serializeFrame: tipo de frame desconhecido (${String(type)})`);

  const parsed = schema.safeParse(frame);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `serializeFrame: frame inválido em ${issue?.path.join('.') || 'frame'} (${issue?.code ?? 'invalid'})`,
    );
  }

  const oversized = payloadTooLarge(parsed.data as Record<string, unknown>);
  if (oversized) {
    throw new WireLimitError(
      oversized,
      canonicalByteLength((parsed.data as Record<string, unknown>)[oversized.split('.')[0] as string]),
      WIRE_LIMITS.max_tool_payload_bytes,
    );
  }

  const line = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > WIRE_LIMITS.max_frame_bytes) {
    throw new WireLimitError('frame', bytes, WIRE_LIMITS.max_frame_bytes);
  }
  return `${line}\n`;
}

/**
 * `call_id` do journal (§4.1): derivado, nunca recebido. Falha ALTO em entrada
 * malformada — um call_id inválido quebraria a unicidade que o journal usa para
 * reconhecer redelivery.
 */
export function deriveCallId(run_id: string, call_seq: number): string {
  if (!UUID_RE.test(run_id)) {
    throw new Error('deriveCallId: run_id precisa ser UUID');
  }
  if (!Number.isInteger(call_seq) || call_seq < 0 || call_seq > WIRE_LIMITS.max_call_seq) {
    throw new Error('deriveCallId: call_seq precisa ser inteiro em [0, max_call_seq]');
  }
  return `${run_id.toLowerCase()}:${call_seq}`;
}
