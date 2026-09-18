/**
 * P06 (spec §9.1 validações 3-5 e 8-9, §9.2) — as decisões PURAS do caminho de
 * um request no gateway que não cabem em `inference-gateway.ts` (que é o
 * contrato) nem no repositório (que é o estado travado).
 *
 * Sem banco, sem rede, sem relógio. Cada função responde uma pergunta:
 *
 *  - a superfície que o filho mandou é a que o grant autoriza — nomes E
 *    schemas, no pedido, no `tool_choice` e no histórico?
 *  - qual é o teto de saída deste request?
 *  - quanto reservar (exposição conservadora) e quanto custou (uso reportado)?
 *  - como a resposta do provider vira o formato estrito do contrato?
 *  - como a resposta validada volta ao filho em SSE, que é o que o cliente
 *    pinado pede sempre (`stream: true`, medido no SHA 5d59366)?
 *  - a requisição veio de uma origem autorizada, sem passar pelo proxy público?
 *
 * Dinheiro é inteiro: tarifas em NANOusd por token e resultados em microusd,
 * com arredondamento PARA CIMA — a reserva nunca sai menor que a conta.
 */
import { canonicalDigest } from './canonical-json.js';
import type {
  InferenceRequestV1,
  InferenceResponseV1,
  InferenceUsageObservedV1,
} from './inference-gateway.js';

// ─── superfície ─────────────────────────────────────────────────────────────

export type SurfaceRefusalV1 =
  | 'tool_not_in_surface'
  | 'tool_schema_mismatch'
  | 'tool_choice_outside'
  | 'history_tool_outside';

const own = (o: Record<string, string>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/**
 * §9.1 validação 4 ("nomes e schemas efetivamente enviados") e 5 (`tool_choice`
 * como subconjunto). O histórico também conta: uma `tool_call` de assistant com
 * nome fora da superfície é o modelo sendo lembrado de uma tool que ele não tem.
 */
export function checkRequestSurface(
  request: InferenceRequestV1,
  surface: Record<string, string>,
): { ok: true } | { ok: false; reason: SurfaceRefusalV1 } {
  for (const tool of request.tools ?? []) {
    const name = tool.function.name;
    if (!own(surface, name)) return { ok: false, reason: 'tool_not_in_surface' };
    let digest: string;
    try {
      digest = canonicalDigest(tool.function.parameters);
    } catch {
      return { ok: false, reason: 'tool_schema_mismatch' };
    }
    if (digest !== surface[name]) return { ok: false, reason: 'tool_schema_mismatch' };
  }
  const choice = request.tool_choice;
  if (choice !== undefined && typeof choice === 'object') {
    if (!own(surface, choice.function.name)) return { ok: false, reason: 'tool_choice_outside' };
  }
  if (choice === 'required' && (request.tools ?? []).length === 0) {
    return { ok: false, reason: 'tool_choice_outside' };
  }
  for (const m of request.messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      if (!own(surface, call.function.name)) return { ok: false, reason: 'history_tool_outside' };
    }
  }
  return { ok: true };
}

/**
 * Teto de saída (§9.1 validação 5). Ausente vira o teto do grant; acima dele é
 * recusa, não corte silencioso — o cliente pinado manda o valor do `start`,
 * que já é o do grant. O teto segue no MESMO campo que o cliente usou
 * (`max_completion_tokens` nas famílias OpenAI que recusam `max_tokens`).
 */
export function enforceOutputCap(
  request: InferenceRequestV1,
  cap: number,
):
  | { ok: true; field: 'max_tokens' | 'max_completion_tokens'; max_tokens: number }
  | { ok: false } {
  const field =
    request.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  const pedido = request[field];
  if (pedido === undefined) return { ok: true, field, max_tokens: cap };
  if (pedido > cap) return { ok: false };
  return { ok: true, field, max_tokens: pedido };
}

// ─── dinheiro ───────────────────────────────────────────────────────────────

/** Tarifa versionada do modelo, em nanousd por token (US$/Mtok × 1000). */
export interface InferenceTariffV1 {
  version: string;
  input_nanousd_per_token: number;
  output_nanousd_per_token: number;
}

function nano(n: number, field: string): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${field} precisa ser inteiro >= 0`);
  return BigInt(n);
}

function ceilMicro(nanousd: bigint): string {
  return ((nanousd + 999n) / 1000n).toString();
}

/**
 * Cota SUPERIOR de tokens de entrada, sem tokenizer: um token de BPE cobre pelo
 * menos um byte, então bytes UTF-8 do conteúdo enviado limitam os tokens por
 * cima. A folga por mensagem cobre os tokens de papel/separador.
 */
export function inputTokensUpperBound(request: InferenceRequestV1): number {
  const bytes = Buffer.byteLength(
    JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }),
    'utf8',
  );
  return bytes + 16 * request.messages.length;
}

/**
 * Exposição conservadora do request (§9.2 "calcular exposição conservadora com
 * tarifa versionada conhecida"). `null` = sem tarifa: quem decide o que fazer
 * com isso é a policy da admissão, não esta conta.
 */
export function estimateExposureMicrousd(
  input_tokens_upper: number,
  max_output_tokens: number,
  tariff: InferenceTariffV1 | null,
): string | null {
  if (tariff === null) return null;
  const total =
    nano(input_tokens_upper, 'input_tokens') * nano(tariff.input_nanousd_per_token, 'input_rate') +
    nano(max_output_tokens, 'output_tokens') * nano(tariff.output_nanousd_per_token, 'output_rate');
  return ceilMicro(total);
}

/** Custo do uso reportado. `null` quando não há uso ou tarifa: nunca zero inventado. */
export function costFromUsage(
  usage: InferenceUsageObservedV1 | null,
  tariff: InferenceTariffV1 | null,
): string | null {
  if (usage === null || tariff === null) return null;
  const total =
    nano(usage.prompt_tokens, 'prompt_tokens') *
      nano(tariff.input_nanousd_per_token, 'input_rate') +
    nano(usage.completion_tokens, 'completion_tokens') *
      nano(tariff.output_nanousd_per_token, 'output_rate');
  return ceilMicro(total);
}

// ─── resposta ───────────────────────────────────────────────────────────────

/** Contagem de tokens que cabe numa coluna `int4 >= 0`. */
export const MAX_TOKEN_COUNT = 2_147_483_647;
const isTokenCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOKEN_COUNT;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Projeta a resposta do provider no formato ESTRITO do contrato, antes de
 * `parseInferenceResponse`. Campos que o provider acrescenta (`logprobs`,
 * `refusal`, `system_fingerprint`, detalhes de uso) ficam para trás; o que o
 * contrato exige e faltar continua faltando, e o parse recusa. Uso parcial
 * some inteiro: meio uso é uso desconhecido.
 */
export function projectChatCompletion(raw: unknown): unknown {
  if (!isObj(raw) || !Array.isArray(raw.choices)) return raw;
  const choices = raw.choices.map((c: unknown) => {
    if (!isObj(c) || !isObj(c.message)) return c;
    const m = c.message;
    const message: Record<string, unknown> = {
      role: m.role,
      content: m.content ?? null,
    };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      message.tool_calls = m.tool_calls.map((tc: unknown) =>
        isObj(tc) && isObj(tc.function)
          ? {
              id: tc.id,
              type: tc.type,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }
          : tc,
      );
    }
    return { index: c.index, message, finish_reason: c.finish_reason ?? null };
  });
  const out: Record<string, unknown> = {
    id: raw.id,
    object: raw.object,
    created: raw.created,
    model: raw.model,
    choices,
  };
  // Uso fora do que o ledger registra (negativo, fracionário, > int4) sai da
  // resposta: o filho recebe a resposta e o custo fica desconhecido.
  const u = raw.usage;
  if (
    isObj(u) &&
    isTokenCount(u.prompt_tokens) &&
    isTokenCount(u.completion_tokens) &&
    isTokenCount(u.total_tokens)
  ) {
    out.usage = {
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
    };
  }
  return out;
}

/**
 * Uso de uma resposta que NÃO passou no contrato (tool fora da superfície,
 * campo faltando): ainda assim a chamada foi paga, e o uso, se inteiro, entra
 * na conta. Qualquer outra forma — `null`, corpo vazio, uso parcial — é uso
 * desconhecido.
 */
export function usageFromProjected(projected: unknown): InferenceUsageObservedV1 | null {
  if (!isObj(projected) || !isObj(projected.usage)) return null;
  const u = projected.usage;
  // Só o que cabe nas colunas `int4 >= 0` do ledger: o resto é desconhecido.
  return isTokenCount(u.prompt_tokens) &&
    isTokenCount(u.completion_tokens) &&
    isTokenCount(u.total_tokens)
    ? {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens,
      }
    : null;
}

/**
 * A resposta JÁ VALIDADA em SSE de Chat Completions. O §9.1 item 8 exige
 * "buffering suficiente para não liberar tool inválida": aqui não há stream do
 * provider, há a resposta inteira conferida, re-emitida em pedaços.
 */
export function renderChatCompletionSse(
  response: InferenceResponseV1,
  include_usage: boolean,
): string {
  const head = {
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created,
    model: response.model,
  };
  const out: string[] = [];
  const chunk = (index: number, delta: Record<string, unknown>, finish: string | null): void => {
    out.push(
      `data: ${JSON.stringify({ ...head, choices: [{ index, delta, finish_reason: finish }] })}\n\n`,
    );
  };
  for (const choice of response.choices) {
    chunk(choice.index, { role: 'assistant' }, null);
    if (choice.message.content !== null && choice.message.content.length > 0) {
      chunk(choice.index, { content: choice.message.content }, null);
    }
    (choice.message.tool_calls ?? []).forEach((tc, i) => {
      chunk(
        choice.index,
        {
          tool_calls: [
            {
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        },
        null,
      );
    });
    chunk(choice.index, {}, choice.finish_reason);
  }
  // Uso desconhecido não vira um objeto de zeros: o chunk simplesmente não vem.
  if (include_usage && response.usage !== null) {
    out.push(`data: ${JSON.stringify({ ...head, choices: [], usage: response.usage })}\n\n`);
  }
  out.push('data: [DONE]\n\n');
  return out.join('');
}

// ─── rede ───────────────────────────────────────────────────────────────────

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'via'];

/** Origem autorizada: um bloco IPv4 ou um endereço IPv6 exato. */
export type SourceRuleV1 =
  | { kind: 'ipv4'; base: number; mask: number }
  | { kind: 'ipv6'; addr: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(addr: string): number | null {
  const m = IPV4_RE.exec(addr);
  if (!m) return null;
  const octetos = m.slice(1, 5).map(Number);
  if (octetos.some((o) => o > 255)) return null;
  return (
    (((octetos[0]! << 24) >>> 0) + (octetos[1]! << 16) + (octetos[2]! << 8) + octetos[3]!) >>> 0
  );
}

/**
 * Lê a allowlist de origens (`10.0.0.0/8, 172.18.0.5, fd00::10`). Entrada
 * inválida RECUSA a lista inteira: uma regra ilegível descartada em silêncio
 * mudaria quem pode chamar a rota sem ninguém ter decidido.
 */
export function parseSourceAllowlist(text: string | undefined): SourceRuleV1[] | null {
  if (text === undefined || text.trim() === '') return [];
  const rules: SourceRuleV1[] = [];
  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (item.includes(':')) {
      if (!/^[0-9a-f:]+$/i.test(item)) return null;
      rules.push({ kind: 'ipv6', addr: item.toLowerCase() });
      continue;
    }
    const [ip, bits] = item.split('/');
    const base = ipv4ToInt(ip ?? '');
    const prefix = bits === undefined ? 32 : Number(bits);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    rules.push({ kind: 'ipv4', base: (base & mask) >>> 0, mask });
  }
  return rules;
}

function isLoopback(addr: string): boolean {
  if (addr === '::1') return true;
  const v4 = ipv4ToInt(addr);
  return v4 !== null && v4 >>> 24 === 127;
}

/**
 * A rota não é pública (§9.1). Allowlist POSITIVA: loopback sempre, e só as
 * origens configuradas além dela. "Qualquer IP privado" não serve — o proxy da
 * borda também fala da rede privada, e nem todo proxy acrescenta cabeçalho.
 * Cabeçalho de proxy recusa de qualquer jeito.
 */
export function isInternalRequest(input: {
  remote_address: string | undefined;
  headers: Readonly<Record<string, unknown>>;
  allowed?: readonly SourceRuleV1[];
}): boolean {
  for (const h of PROXY_HEADERS) {
    if (input.headers[h] !== undefined) return false;
  }
  if (typeof input.remote_address !== 'string') return false;
  const raw = input.remote_address.toLowerCase();
  const addr = raw.startsWith('::ffff:') && IPV4_RE.test(raw.slice(7)) ? raw.slice(7) : raw;
  if (isLoopback(addr)) return true;
  const v4 = ipv4ToInt(addr);
  for (const rule of input.allowed ?? []) {
    if (rule.kind === 'ipv4' && v4 !== null && (v4 & rule.mask) >>> 0 === rule.base) return true;
    if (rule.kind === 'ipv6' && rule.addr === addr) return true;
  }
  return false;
}
