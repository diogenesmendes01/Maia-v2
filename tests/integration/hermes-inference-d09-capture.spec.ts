/**
 * SC25-A / D09 — CAPTURA do request EFETIVO do cliente Hermes pinado
 * (AIAgent do SHA `5d59366`) contra o gateway+relay reais e provider STUB.
 *
 * ─── O que este arquivo fecha ────────────────────────────────────────────────
 *
 * A decisão D09 ("formato real do request SDK/auxiliares") estava ABERTA: o
 * contrato do gateway admitia a enumeração LITERAL do §9.1, e a captura do
 * cliente fixado não existia como artefato. Aqui ela é medida e GUARDADA:
 *
 *   `tests/fixtures/d09-sdk-requests.json` — requests efetivos (principal, SDK
 *   retry, follow-up), redigidos, com o schema exato derivado deles E VALIDADO
 *   contra os próprios corpos, a lista fechada de HEADERS admitidos pela rota
 *   (só nomes), a lista de rotas auxiliares permitida/negada vinda do PRÓPRIO
 *   worker Python, e as observações por família de modelo
 *   (`max_completion_tokens`, `developer`).
 *
 * ─── Por que a lane de INTEGRAÇÃO, e não o spike ────────────────────────────
 *
 * Este arquivo mora em `tests/integration/` porque é a lane que o CI provê com
 * o pin do Hermes (`HERMES_PIN_*`) e roda com `--max-pulados 0`: um gate de
 * drift que nenhuma lane executa é um gate declarado, não verificado. A
 * ausência do pin PULA (a lane de unit roda `npx vitest run` sem pin, e lá não
 * existe teto de pulados); com o pin, os casos RODAM.
 *
 * ─── Modo verificador x modo gerador ────────────────────────────────────────
 *
 * Por padrão o teste CAPTURA de novo e exige igualdade com a fixture commitada:
 * drift de SDK (campo novo, role nova, header novo, limite com outro nome)
 * REPROVA — é o que a AC04 chama de "drift bloqueia readiness". `D09_WRITE_FIXTURE`
 * não é variável de ambiente: o modo gerador usa o marcador local
 * `tests/fixtures/.regen-d09`, não commitado e removido após a captura.
 *
 * ─── Tier dos doubles (o que este teste NÃO prova) ──────────────────────────
 *
 * O provedor é STUB e o cliente do teste é o `AIAgent` real do checkout
 * pinado. O que se mede é o request que o SDK EMITE e que o gateway ADMITE; o
 * que NÃO se mede é resposta de modelo real, latência real ou custo real
 * (decisão D02). A captura é feita na fronteira do relay — o corpo que o
 * gateway admite e entrega ao relay — e não no socket do filho; essa é a
 * limitação declarada da medição. Dos headers se guarda o NOME, nunca o valor.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { InferenceGrantStateV1, SettleOutcomeV1 } from '@/db/repositories/inference-repos.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  hashInferenceToken,
  mintInferenceToken,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';
import {
  INFERENCE_GATEWAY_BASE_PATH,
  INFERENCE_GATEWAY_COMPLETIONS_PATH,
} from '@/integrations/hermes/inference-gateway.js';
import {
  INFERENCE_REQUEST_HEADER_PREFIXES,
  INFERENCE_REQUEST_HEADERS_ALLOWED,
  checkInferenceRequestHeaders,
  checkPinnedSdkSurface,
} from '@/integrations/hermes/inference-sdk-surface.js';
import { registerHermesInferenceRoute } from '@/integrations/hermes/inference-route.js';
import type { StartFrame } from '@/integrations/hermes/protocol.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { validate } from '../helpers/json-schema-validator.js';
import { startStubProvider, type StubProvider } from '../helpers/hermes-stub-provider.js';

/**
 * Checkout pinado do Hermes: o CI provisiona `HERMES_PIN_*` para a lane de
 * integração; o dev local usa `MAIA_HERMES_*`. A ausência dos dois PULA aqui
 * (a lane de unit roda `npx vitest run` sem pin e sem teto de pulados) — quem
 * impede o "verde vazio" é a lane de integração, que executa `tests/integration`
 * com `--max-pulados 0` e o pin provisionado, e é por isso que este arquivo
 * mora ali: o gate de drift D09 é EXERCITADO em CI, não só declarado.
 */
const PYTHON = process.env.HERMES_PIN_PYTHON ?? process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.HERMES_PIN_UPSTREAM ?? process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

const REPO = resolve(process.cwd());
const SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const MODEL = 'maia-stub-model';
const FIXTURE_PATH = resolve(REPO, 'tests/fixtures/d09-sdk-requests.json');
/**
 * Modo GERADOR da fixture. Não é variável de ambiente de propósito: a receita
 * de card roda o vitest por `project_env.py`, que monta um ambiente
 * allowlistado e descarta variáveis inventadas — um `D09_WRITE_FIXTURE=1`
 * exportado na mão seria silenciosamente ignorado e o teste "geraria" nada.
 * O marcador abaixo é local, não é commitado e é removido logo após a captura.
 */
const REGEN_MARKER = resolve(REPO, 'tests/fixtures/.regen-d09');
const WRITE_MODE = existsSync(REGEN_MARKER);

const TOOLS = [
  {
    name: 'fixture_echo',
    input_schema: {
      type: 'object',
      description: 'Ecoa o texto.',
      properties: { texto: { type: 'string' } },
      required: ['texto'],
      additionalProperties: false,
    },
    result_limit_chars: 4096,
  },
];
type SpikeTool = (typeof TOOLS)[number];

const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-d09-'));
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

// ─── classificação de um request efetivo ────────────────────────────────────

type CallClass = 'principal' | 'retry' | 'aux';

/** Tipos JSON de um campo, como observados (ex.: `content` → `['string']`). */
type FieldTypes = Record<string, string[]>;

/** Estrutura de UMA mensagem (não agregada por papel): é o que permite derivar
 * `required` como INTERSEÇÃO e `properties` como UNIÃO sem inventar nada. */
type MessageShape = {
  role: string;
  /** Campos presentes NESTA mensagem, ordenados. */
  fields: string[];
  types: FieldTypes;
};

type CapturedCall = {
  seq: number;
  class: CallClass;
  /** Por que esta chamada é desta classe — sem inferência silenciosa. */
  reason: string;
  top_level_fields: string[];
  message_roles: string[];
  messages: MessageShape[];
  tool_object_fields: string[];
  tool_function_fields: string[];
  tool_function_types: FieldTypes;
  /** Valores observados do discriminador `tools[].type`. */
  tool_type_values: string[];
  tool_call_fields: string[];
  tool_call_function_fields: string[];
  tool_call_function_types: FieldTypes;
  /** Valores observados do discriminador `tool_calls[].type`. */
  tool_call_type_values: string[];
  stream_options_fields: string[];
  stream_options_types: FieldTypes;
  tool_names: string[];
  /** Nome do campo de teto de saída efetivamente emitido. */
  output_limit_field: string | null;
  stream: boolean | null;
  content_kinds: string[];
  /**
   * NOMES dos headers observados nesta chamada (ordenados). NUNCA valores: o
   * `authorization` está aqui como NOME, o bearer não é registrado.
   */
  headers: string[];
};

function fieldNames(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

/** Tipo JSON de um valor, na nomenclatura do JSON Schema. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // 'string' | 'boolean' | 'object'
}

function typesOf(value: unknown): FieldTypes {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: FieldTypes = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[k] = [jsonType(v)];
  }
  return out;
}

/** Primeiro elemento de um array de objetos, se houver. */
function firstObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return undefined;
  return first as Record<string, unknown>;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? sortedUnique(value.filter((v): v is string => typeof v === 'string')) : [];
}

/**
 * Redige o request efetivo: guarda a ESTRUTURA (nomes de campo, roles, tipos de
 * conteúdo, tipos por campo, digests de schema) e nunca o texto da conversa, o
 * prompt de sistema nem o valor de credencial. Dos headers guarda só o NOME.
 */
function captureCall(
  seq: number,
  cls: CallClass,
  reason: string,
  body: Record<string, unknown>,
  headers: readonly string[],
): CapturedCall {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const messageShapes: MessageShape[] = messages.map((m) => ({
    role: typeof m.role === 'string' ? m.role : '<sem-role>',
    fields: fieldNames(m),
    types: typesOf(m),
  }));
  const contentKinds = new Set<string>();
  for (const m of messages) {
    const c = m.content;
    contentKinds.add(c === null ? 'null' : c === undefined ? 'absent' : typeof c);
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];
  const primeiroTool = firstObject(tools);
  const primeiroToolCall = messages
    .map((m) => firstObject(m.tool_calls))
    .find((c): c is Record<string, unknown> => c !== undefined);
  const toolNames: string[] = [];
  for (const t of tools) {
    const fn = t.function as { name?: unknown } | undefined;
    if (fn && typeof fn.name === 'string') toolNames.push(fn.name);
  }
  const limitField = ['max_tokens', 'max_completion_tokens'].find((f) => f in body) ?? null;
  const streamOptions = body.stream_options;
  const streamOptionsObject =
    streamOptions !== null && typeof streamOptions === 'object' && !Array.isArray(streamOptions)
      ? (streamOptions as Record<string, unknown>)
      : undefined;
  return {
    seq,
    class: cls,
    reason,
    top_level_fields: fieldNames(body),
    message_roles: sortedUnique(messageShapes.map((m) => m.role)),
    messages: messageShapes,
    tool_object_fields: fieldNames(primeiroTool),
    tool_function_fields: fieldNames(primeiroTool?.function),
    tool_function_types: typesOf(primeiroTool?.function),
    tool_type_values: stringValues(tools.map((t) => t.type)),
    tool_call_fields: fieldNames(primeiroToolCall),
    tool_call_function_fields: fieldNames(primeiroToolCall?.function),
    tool_call_function_types: typesOf(primeiroToolCall?.function),
    tool_call_type_values: stringValues(
      messages.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls : [])).map((t) => (t as Record<string, unknown>).type),
    ),
    stream_options_fields: fieldNames(streamOptionsObject),
    stream_options_types: typesOf(streamOptionsObject),
    tool_names: toolNames.sort(),
    output_limit_field: limitField,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    content_kinds: sortedUnique(contentKinds),
    headers: sortedUnique(headers),
  };
}

// ─── derivação do schema FECHADO a partir da captura ────────────────────────

/** Ramo de `messages.items` para um PAPEL: fechado, com os campos daquele papel. */
type RoleAcc = { conjuntos: Array<Set<string>>; tipos: Map<string, Set<string>> };

function accumulate(acc: Map<string, RoleAcc>, role: string, fields: string[], types: FieldTypes): void {
  const atual = acc.get(role) ?? { conjuntos: [], tipos: new Map<string, Set<string>>() };
  atual.conjuntos.push(new Set(fields));
  for (const [field, ts] of Object.entries(types)) {
    const set = atual.tipos.get(field) ?? new Set<string>();
    for (const t of ts) set.add(t);
    atual.tipos.set(field, set);
  }
  acc.set(role, atual);
}

/** `{type}` quando há UM tipo observado; `anyOf` quando há mais (ex.: content). */
function typeSchema(types: Iterable<string>): Record<string, unknown> {
  const lista = sortedUnique(types);
  if (lista.length === 1) return { type: lista[0]! };
  return { anyOf: lista.map((t) => ({ type: t })) };
}

/** `required` = campos presentes em TODAS as observações; `properties` = união. */
function requiredOf(conjuntos: Array<Set<string>>): string[] {
  if (conjuntos.length === 0) return [];
  return [...conjuntos[0]!].filter((f) => conjuntos.every((s) => s.has(f))).sort();
}

/** Objeto FECHADO a partir de tipos por campo observados. */
function closedObject(
  conjuntos: Array<Set<string>>,
  tipos: Map<string, Set<string>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of [...tipos.keys()].sort()) properties[field] = typeSchema(tipos.get(field)!);
  return {
    type: 'object',
    additionalProperties: false,
    required: requiredOf(conjuntos),
    properties: { ...properties, ...extra },
  };
}

/**
 * JSON Schema EXATO do pedido, derivado dos requests observados.
 *
 * `additionalProperties: false` é o ponto: o schema não é uma descrição do que
 * se viu, é a afirmação de que NADA além disso é admitido — em TODO nível que a
 * captura fechou (topo, mensagem, objeto de tool, função de tool, `tool_calls` e
 * `stream_options`). Tipos e presença vêm dos valores capturados, e o papel da
 * mensagem vira ramo (`anyOf`), de forma que `tool_call_id` numa mensagem de
 * `user` seja RECUSADO, não aceito por estar na união.
 *
 * `tools[].function.parameters` fica como objeto livre porque o schema de cada
 * tool é o do manifest normalizado — conferido por digest em `tool_surface`,
 * não por este arquivo.
 */
function deriveSchema(calls: CapturedCall[]): Record<string, unknown> {
  const presentes = calls.map((c) => new Set(c.top_level_fields));
  const todos = sortedUnique(calls.flatMap((c) => c.top_level_fields));
  const sempre = todos.filter((f) => presentes.every((s) => s.has(f)));
  const properties: Record<string, unknown> = {};

  // ── mensagens: um ramo por papel (união de campos por ramo, required = ⊆) ──
  const papeis = new Map<string, RoleAcc>();
  for (const call of calls) {
    for (const m of call.messages) accumulate(papeis, m.role, m.fields, m.types);
  }
  // Estrutura de `tool_calls` (medida uma vez; usada só no ramo que a emitiu).
  const callFnSets: Array<Set<string>> = [];
  const callFnTypes = new Map<string, Set<string>>();
  for (const call of calls) {
    if (call.tool_call_fields.length === 0) continue;
    callFnSets.push(new Set(call.tool_call_function_fields));
    for (const [f, ts] of Object.entries(call.tool_call_function_types)) {
      const set = callFnTypes.get(f) ?? new Set<string>();
      for (const t of ts) set.add(t);
      callFnTypes.set(f, set);
    }
  }
  const toolCallSchema = {
    type: 'array' as const,
    minItems: 1,
    items: {
      type: 'object' as const,
      additionalProperties: false,
      required: sortedUnique(
        calls
          .filter((c) => c.tool_call_fields.length > 0)
          .flatMap((c) => c.tool_call_fields),
      ),
      properties: {
        id: { type: 'string' as const },
        type: { enum: sortedUnique(calls.flatMap((c) => c.tool_call_type_values)) },
        function: closedObject(callFnSets, callFnTypes),
      },
    },
  };
  const ramos = [...papeis.keys()].sort().map((role) => {
    const acc = papeis.get(role)!;
    const hasToolCalls = acc.tipos.has('tool_calls');
    if (hasToolCalls && callFnSets.length === 0) {
      throw new Error('captura declara tool_calls numa mensagem mas não guardou a estrutura: recapture antes de derivar');
    }
    const fechado = closedObject(acc.conjuntos, acc.tipos);
    return {
      type: 'object' as const,
      additionalProperties: false,
      // `role` é sempre obrigatório: é o discriminador do ramo.
      required: sortedUnique([...requiredOf(acc.conjuntos), 'role']),
      properties: {
        ...(fechado.properties as Record<string, unknown>),
        role: { enum: [role] },
        // `tool_calls` só no ramo que o emitiu: derivação medida, não global.
        ...(hasToolCalls ? { tool_calls: toolCallSchema } : {}),
      },
    };
  });

  // ── tools[].function: fechado, com os campos de função observados ──────────
  const toolFnSets: Array<Set<string>> = [];
  const toolFnTypes = new Map<string, Set<string>>();
  for (const call of calls) {
    if (call.tool_function_fields.length === 0) continue;
    toolFnSets.push(new Set(call.tool_function_fields));
    for (const [f, ts] of Object.entries(call.tool_function_types)) {
      const set = toolFnTypes.get(f) ?? new Set<string>();
      for (const t of ts) set.add(t);
      toolFnTypes.set(f, set);
    }
  }
  const toolObjectSets = calls
    .filter((c) => c.tool_object_fields.length > 0)
    .map((c) => new Set(c.tool_object_fields));

  for (const field of todos) {
    if (field === 'model') properties[field] = { type: 'string' };
    else if (field === 'stream') properties[field] = { type: 'boolean' };
    else if (field === 'max_tokens' || field === 'max_completion_tokens') {
      properties[field] = { type: 'integer', minimum: 1 };
    } else if (field === 'messages') {
      properties[field] = { type: 'array', minItems: 1, items: { anyOf: ramos } };
    } else if (field === 'tools') {
      const fnSchema = closedObject(toolFnSets, toolFnTypes, { parameters: { type: 'object' } });
      properties[field] = {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: requiredOf(toolObjectSets),
          properties: {
            type: { enum: sortedUnique(calls.flatMap((c) => c.tool_type_values)) },
            function: fnSchema,
          },
        },
      };
    } else if (field === 'stream_options') {
      const sets: Array<Set<string>> = [];
      const tipos = new Map<string, Set<string>>();
      for (const call of calls) {
        if (call.stream_options_fields.length === 0) continue;
        sets.push(new Set(call.stream_options_fields));
        for (const [f, ts] of Object.entries(call.stream_options_types)) {
          const set = tipos.get(f) ?? new Set<string>();
          for (const t of ts) set.add(t);
          tipos.set(f, set);
        }
      }
      properties[field] = closedObject(sets, tipos);
    } else {
      properties[field] = { type: 'object' };
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'maia.hermes.pinned-sdk.chat-completions.request.v1',
    type: 'object',
    additionalProperties: false,
    required: sempre,
    properties,
  };
}

// ─── harness (gateway real + relay real + stub) ─────────────────────────────

function grantState(model: string): InferenceGrantStateV1 {
  return {
    grant_id: randomUUID(),
    grant: {
      run_id: randomUUID(),
      tenant_id: 'tenant-d09',
      agent_id: 'agent-d09',
      control_epoch: '0',
      audience: INFERENCE_GRANT_AUDIENCE,
      model,
      manifest_digest: 'a'.repeat(64),
      allowed_tool_names: TOOLS.map((t) => t.name),
      expires_at: new Date(Date.now() + 180_000).toISOString(),
      revoked_at: null,
      max_inference_calls: 8,
    },
    tool_surface: toolSurfaceOf(TOOLS as readonly SpikeTool[], model),
    max_output_tokens: 256,
    run_phase: 'running',
    run_manifest_digest: 'a'.repeat(64),
    run_deadline_at: new Date(Date.now() + 180_000).toISOString(),
    calls_so_far: 0,
    control_ok: true,
    owner: 'ok',
    now: new Date().toISOString(),
  };
}

async function gateway(stub: StubProvider, token: string, model = MODEL) {
  const st = grantState(model);
  const admitted: string[] = [];
  const settled: SettleOutcomeV1[] = [];
  /** Corpos EFETIVOS: o que o gateway admitiu e entregou ao relay. */
  const forwarded: Record<string, unknown>[] = [];
  /**
   * NOMES dos headers de CADA request de INFERÊNCIA recebido, na ordem. É a
   * evidência de AC03: a rota ADMITE o que o cliente pinado manda, e o que ela
   * recusaria aparece aqui como nome — nunca como valor.
   */
  const headerNames: string[][] = [];
  /**
   * Requisições que o cliente pinado faz à MESMA base mas FORA da rota de
   * inferência — as sondas de descoberta de provider do `AIAgent`
   * (`/v1/models`, `/props`, `/api/tags`, `/version`…). Elas aparecem de forma
   * INTERMITENTE (dependem do caminho de resolução de modelo do run), por isso
   * NÃO entram na fixture: um artefato de contrato não pode oscilar. O que fica
   * registrado aqui é só a prova de que o hook as reconhece e as exclui do
   * request efetivo.
   */
  const discovery = new Set<string>();
  const app: FastifyInstance = Fastify();
  cleanup.push(() => app.close());
  // Antes de registrar a rota: o hook de coleta precisa valer para ela.
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? req.url;
    if (req.method === 'POST' && url === INFERENCE_GATEWAY_COMPLETIONS_PATH) {
      headerNames.push(Object.keys(req.headers).sort());
      return;
    }
    discovery.add(`${req.method} ${url}`);
  });
  const base = createChatCompletionsRelay({ provider: 'stub', apiKey: 'chave-do-provider-stub', baseURL: stub.baseUrl });
  await registerHermesInferenceRoute(app, {
    ledger: {
      resolveGrantScope: async (h) =>
        h === hashInferenceToken(token)
          ? { grant_id: st.grant_id, tenant_id: 'tenant-d09', agent_id: 'agent-d09' }
          : null,
      loadGrantState: async () => ({ ...st, calls_so_far: admitted.length, now: new Date().toISOString() }),
      admitAttempt: async (input) => {
        admitted.push(input.attempt_id);
        return { ok: true, attempt_id: input.attempt_id, attempt_seq: admitted.length, reserved_microusd: '1' };
      },
      settleAttempt: async ({ outcome }) => {
        settled.push(outcome);
        return { ok: true, already: false, accounting_status: 'settled' };
      },
    },
    relay: {
      provider: base.provider,
      relay: async (body, opts) => {
        forwarded.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
        return base.relay(body, opts);
      },
    },
    tariffFor: async () => ({ version: 'tarifa-d09', input_nanousd_per_token: 1000, output_nanousd_per_token: 1000 }),
    runInScope: (_s, fn) => fn(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}${INFERENCE_GATEWAY_BASE_PATH}`,
    admitted,
    settled,
    forwarded,
    headerNames,
    discovery: sortedUnique(discovery),
  };
}

type Frame = Record<string, unknown>;
const NL = String.fromCharCode(10);

function spawnWorker(token: string) {
  const home = mkdtempSync(join(HOME_ROOT, 'home-'));
  const child = spawn(PYTHON as string, ['-m', 'services.hermes_worker.main'], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONPATH: `${UPSTREAM}${process.platform === 'win32' ? ';' : ':'}${REPO}`,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HERMES_HOME: home,
      MAIA_HERMES_SHA: SHA,
      MAIA_HERMES_INFERENCE_KEY: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  }) as ChildProcessWithoutNullStreams;
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill();
  });
  const frames: Frame[] = [];
  const waiting: Array<{ type: string; resolve: (f: Frame) => void }> = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf(NL);
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const f = JSON.parse(line) as Frame;
        frames.push(f);
        const i = waiting.findIndex((w) => w.type === f.type);
        if (i >= 0) waiting.splice(i, 1)[0]!.resolve(f);
      }
      nl = buf.indexOf(NL);
    }
  });
  child.stderr.resume();
  return {
    frames,
    send: (f: Frame) => child.stdin.write(JSON.stringify(f) + NL),
    waitFor: (type: string) =>
      new Promise<Frame>((res, rej) => {
        const found = frames.find((f) => f.type === type);
        if (found) return res(found);
        const t = setTimeout(() => rej(new Error(`timeout esperando ${type}`)), 120_000);
        waiting.push({ type, resolve: (f) => (clearTimeout(t), res(f)) });
      }),
    exit: () =>
      new Promise<number | null>((res) => {
        if (child.exitCode !== null) return res(child.exitCode);
        child.on('exit', (c) => res(c));
      }),
  };
}

function startFrame(base_url: string, model = MODEL): StartFrame {
  const run_id = randomUUID();
  return {
    protocol: 'maia.hermes.worker.v1',
    type: 'start',
    run_id,
    request_key: randomUUID(),
    binding: {
      execution_id: run_id,
      task_id: `task-${run_id}`,
      initial_session_id: `sess-${run_id}`,
      manifest_digest: 'b'.repeat(64),
      mode: 'live',
    },
    manifest: {
      schema: 'maia-hermes-runtime-manifest/v1',
      tools: TOOLS as StartFrame['manifest']['tools'],
      result_limit_chars: 4096,
    },
    context: {
      system: 'Você é um atendente de teste. Responda curto.',
      user_message: '<user_message>diga oi</user_message>',
      history: [],
    },
    limits: {
      max_iterations: 4,
      max_output_tokens_per_call: 256,
      max_tool_calls: 2,
      max_inference_calls: 8,
      run_budget_seconds: 180,
      deadline_at: new Date(Date.now() + 180_000).toISOString(),
    },
    inference: { base_url, model, provider: 'openai', api_mode: 'chat_completions' },
  };
}

/** A lista auxiliar vem do PRÓPRIO worker: uma fonte, não duas. */
function auxPolicyFromWorker(): Record<string, unknown> {
  const out = execFileSync(PYTHON as string, ['-m', 'services.hermes_worker.main', '--print-aux-policy'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: `${UPSTREAM}:${REPO}`, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(out) as Record<string, unknown>;
}

d('SC25-A / D09 — captura do request efetivo do cliente pinado', () => {
  it('principal + SDK retry + follow-up, com aux demonstrado ausente do relay', async () => {
    // Roteiro: a PRIMEIRA chamada falha 5xx no provider ⇒ o gateway responde 503
    // (retryável) ⇒ o SDK pinado repete; a repetição volta com tool_call; o
    // resultado da tool dispara a chamada de follow-up, que fecha com texto.
    const stub = await startStubProvider({
      script: [
        { kind: 'error', status: 500, body: { error: { message: 'falha injetada', type: 'server_error' } } },
        { kind: 'tool_calls', calls: [{ name: 'fixture_echo', arguments: { texto: 'eco' } }] },
        { kind: 'text', content: 'eco respondido' },
      ],
    });
    cleanup.push(() => stub.close());
    const token = mintInferenceToken();
    const gw = await gateway(stub, token);
    const worker = spawnWorker(token);
    const start = startFrame(gw.base);
    worker.send(start);
    await worker.waitFor('ready');
    const pedido = await worker.waitFor('tool.request');
    worker.send({
      protocol: 'maia.hermes.worker.v1',
      type: 'tool.result',
      run_id: start.run_id,
      call_seq: 0,
      outcome: { kind: 'result', result: { eco: 'eco' }, is_error: false },
    });
    const result = await worker.waitFor('result');
    worker.send({
      protocol: 'maia.hermes.worker.v1',
      type: 'result_ack',
      run_id: start.run_id,
      terminal_digest: 'c'.repeat(64),
    });
    const exit = await worker.exit();

    // Pré-condição MEDIDA do cenário: a repetição existe e passou pela admissão.
    expect(exit).toBe(0);
    expect(result.stop).toEqual({ kind: 'reply', raw_text: 'eco respondido' });
    expect(gw.forwarded).toHaveLength(3);
    expect(gw.settled.map((s) => s.kind)).toEqual(['failed_after_send', 'completed', 'completed']);
    expect(pedido).toMatchObject({ call_seq: 0, name: 'fixture_echo' });
    // Um request de inferência, um registro de headers: a correlação por índice é
    // legítima porque o hook só conta o POST da rota de inferência.
    expect(gw.headerNames).toHaveLength(gw.forwarded.length);
    // Sondas de descoberta do cliente, quando existirem, ficam FORA da captura
    // (intermitentes): o que o hook registrou é só "método + caminho", sem valor.
    expect(gw.discovery.every((r) => /^(GET|POST|HEAD) \//.test(r))).toBe(true);

    const calls: CapturedCall[] = [
      captureCall(1, 'principal', 'primeira chamada HTTP do run', gw.forwarded[0]!, gw.headerNames[0]!),
      captureCall(2, 'retry', 'mesma chamada lógica repetida pelo SDK após 503 do gateway', gw.forwarded[1]!, gw.headerNames[1]!),
      captureCall(3, 'principal', 'nova chamada lógica depois do tool.result', gw.forwarded[2]!, gw.headerNames[2]!),
    ];

    // A repetição é do MESMO corpo lógico: o que difere é só a posição na série.
    expect(calls[1]!.top_level_fields).toEqual(calls[0]!.top_level_fields);
    expect(calls[1]!.message_roles).toEqual(calls[0]!.message_roles);

    const aux = auxPolicyFromWorker();
    expect(aux.allowed).toEqual([]);
    const denied = aux.denied as Array<{ route: string; posture: string }>;
    expect(denied.map((r) => r.route)).toContain('compression');
    expect(denied.every((r) => r.posture === 'disabled')).toBe(true);
    // Nenhuma rota auxiliar tocou o relay nesta captura: cada corpo entregue ao
    // relay corresponde a um dos requests capturados (e `aux_calls_observed` é
    // zero no artefato).
    const conjuntos = calls.map((c) => JSON.stringify(c.top_level_fields));
    expect(gw.forwarded.every((b) => conjuntos.includes(JSON.stringify(fieldNames(b))))).toBe(true);

    // ─── headers (AC03): o que o cliente MANDA é admitido pela lista fechada ──
    const headers = {
      version: 1,
      // NOMES, nunca valores. `authorization` aparece como nome.
      observed: sortedUnique(calls.flatMap((c) => c.headers)),
      allowed: [...INFERENCE_REQUEST_HEADERS_ALLOWED].sort(),
      allowed_prefixes: [...INFERENCE_REQUEST_HEADER_PREFIXES].sort(),
      redaction: 'apenas NOMES de header; nenhum valor é registrado (nem o bearer)',
    };
    // A lista fechada COBRE o que o cliente pinado envia — medido, não suposto.
    const vereditoHeaders = checkInferenceRequestHeaders(
      Object.fromEntries(headers.observed.map((h) => [h, 'x'])),
    );
    expect(vereditoHeaders).toEqual({ ok: true, refused: [] });
    // E a razão de `x-stainless-*` ser PREFIXO: o SDK emite a família, não um
    // nome só (lang/os/arch/runtime/versão/retry/timeout).
    expect(headers.observed.some((h) => h.startsWith('x-stainless-'))).toBe(true);
    // Nenhum header de autoridade alternativa chegou para ser admitido: se
    // chegasse, estaria em `observed` e a lista acima o recusaria.
    for (const proibido of ['x-maia-tenant', 'x-model', 'openai-organization', 'x-provider-base-url']) {
      expect(headers.observed).not.toContain(proibido);
    }

    const capture = {
      version: 1,
      hermes_sha: SHA,
      captured_by: 'tests/integration/hermes-inference-d09-capture.spec.ts',
      tier: {
        client: 'AIAgent REAL do checkout pinado (services/hermes_worker)',
        provider: 'stub loopback (não é modelo)',
        boundary: 'corpo admitido pelo gateway e entregue ao relay (não o socket do filho)',
      },
      redaction: [
        'valor do header Authorization (nunca registrado)',
        'texto de mensagens, prompt de sistema e argumentos de tool',
        'nome/valor de credencial de run ou de provider',
      ],
      headers,
      calls,
      request_schema: deriveSchema(calls),
      aux_routes: aux,
      aux_calls_observed: 0,
    };

    if (WRITE_MODE) {
      writeFileSync(FIXTURE_PATH, JSON.stringify(capture, null, 2) + '\n', 'utf8');
    }
    // A captura VIVA passa pelo MESMO contrato que o readiness do runtime usa:
    // aqui o achado é NOMEADO (campo/rota/header), não só um digest diferente.
    const veredito = checkPinnedSdkSurface({
      hermes_sha: SHA,
      requests: calls.map((c) => ({
        top_level_fields: c.top_level_fields,
        message_roles: c.message_roles,
        output_limit_field: c.output_limit_field,
      })),
      aux_allowed_outside_relay: aux.allowed,
      observed_headers: headers.observed,
    });
    expect(veredito).toEqual({ ok: true, checked_requests: 3 });

    // ─── AC04: o `request_schema` da fixture ACEITA os próprios corpos ───────
    // É o teste que faltava: antes, só se conferia `additionalProperties` e o
    // digest, e o schema commitado recusava os requests capturados.
    const schema = capture.request_schema as Record<string, unknown>;
    for (const [i, body] of gw.forwarded.entries()) {
      const resultado = validate(schema, body);
      expect(resultado.errors, `corpo capturado #${i + 1} recusado pelo próprio schema`).toEqual([]);
      expect(resultado.valid).toBe(true);
    }
    // E o validador MORDE: alterar um nível fechado da captura tem de reprovar.
    const comCampoAMaisNoTopo = { ...gw.forwarded[0], response_format: { type: 'json_object' } };
    expect(validate(schema, comCampoAMaisNoTopo).valid).toBe(false);
    const comCampoAMaisNaMensagem = {
      ...gw.forwarded[0],
      messages: [{ ...(gw.forwarded[0]!.messages as Record<string, unknown>[])[0], tool_call_id: 'x' }],
    };
    expect(validate(schema, comCampoAMaisNaMensagem).valid).toBe(false);
    const comFuncaoMagra = {
      ...gw.forwarded[0],
      tools: [{ type: 'function', function: { name: 'fixture_echo', parameters: {} } }],
    };
    expect(validate(schema, comFuncaoMagra).valid).toBe(false);

    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    const digest = (o: unknown) => canonicalDigest(JSON.parse(JSON.stringify(o)) as never);
    expect(
      digest({
        version: committed.version,
        hermes_sha: committed.hermes_sha,
        headers: committed.headers,
        calls: committed.calls,
        request_schema: committed.request_schema,
        aux_routes: committed.aux_routes,
        aux_calls_observed: committed.aux_calls_observed,
      }),
      'drift entre a captura VIVA do cliente pinado e a fixture D09 commitada',
    ).toBe(
      digest({
        version: capture.version,
        hermes_sha: capture.hermes_sha,
        headers: capture.headers,
        calls: capture.calls,
        request_schema: capture.request_schema,
        aux_routes: capture.aux_routes,
        aux_calls_observed: capture.aux_calls_observed,
      }),
    );
    // O esquema derivado tem de ser FECHADO (passthrough não é admissível).
    expect((capture.request_schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    // E o teto de saída realmente emitido é o que está no schema.
    expect(capture.request_schema).toHaveProperty('properties.max_tokens');
    expect(calls[0]!.output_limit_field).toBe('max_tokens');
    expect(calls[0]!.stream).toBe(true);

    // ─── AC03: header desconhecido RECUSA (o que a QA reprovou) ─────────────
    // Sonda viva contra a rota real: um header de autoridade alternativa
    // responde 400 sanitizado, NÃO consome tentativa e NÃO chega ao provider.
    const admissaoAntes = gw.admitted.length;
    const recusado = await fetch(`${gw.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-maia-tenant': 'tenant-invadido' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'oi' }], max_tokens: 8 }),
    });
    expect(recusado.status).toBe(400);
    const corpoRecusa = (await recusado.json()) as { error?: { code?: string } };
    expect(corpoRecusa.error?.code).toBe('invalid_request');
    expect(JSON.stringify(corpoRecusa)).not.toContain('x-maia-tenant');
    expect(recusado.headers.get('x-should-retry')).toBe('false');
    expect(gw.admitted.length).toBe(admissaoAntes);
    expect(gw.forwarded).toHaveLength(3);
  }, 180_000);

  it('família gpt-5: `max_completion_tokens` e `developer` observados, não presumidos', async () => {
    const stub = await startStubProvider({ script: [{ kind: 'text', content: 'oi' }] });
    cleanup.push(() => stub.close());
    const token = mintInferenceToken();
    const model = 'openai/gpt-5';
    const gw = await gateway(stub, token, model);
    const worker = spawnWorker(token);
    const start = startFrame(gw.base, model);
    worker.send(start);
    await worker.waitFor('ready');
    const result = await worker.waitFor('result');
    worker.send({
      protocol: 'maia.hermes.worker.v1',
      type: 'result_ack',
      run_id: start.run_id,
      terminal_digest: 'c'.repeat(64),
    });
    expect(await worker.exit()).toBe(0);
    expect(result.stop).toEqual({ kind: 'reply', raw_text: 'oi' });
    expect(gw.forwarded).toHaveLength(1);
    expect(gw.headerNames).toHaveLength(1);
    const call = captureCall(1, 'principal', 'chamada única da família gpt-5', gw.forwarded[0]!, gw.headerNames[0]!);

    // O que o SDK pinado FAZ na família gpt-5 (capturado em `1c6a4bc4` e
    // remedido aqui): troca o nome do teto e manda o prompt como `developer`.
    const esperado = { output_limit_field: 'max_completion_tokens', system_role: 'developer' };
    const observed = {
      model: 'openai/gpt-5',
      ...esperado,
      observed_by: 'tests/integration/hermes-inference-d09-capture.spec.ts',
    };
    if (WRITE_MODE) {
      const atual = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
      atual.families = { 'gpt-5': observed };
      writeFileSync(FIXTURE_PATH, JSON.stringify(atual, null, 2) + '\n', 'utf8');
    }
    // Lido DEPOIS do modo gerador para que a asserção compare o arquivo final.
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      families?: Record<string, unknown>;
    };
    expect(committed.families?.['gpt-5']).toEqual(observed);
    // A fixture declara o mesmo fato E a observação viva do cliente o confirma.
    expect(call.output_limit_field).toBe(esperado.output_limit_field);
    expect(call.message_roles).toContain(esperado.system_role);
  }, 180_000);
});
