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
 *  - a requisição veio da rede interna, sem passar pelo proxy público?
 *
 * Dinheiro é inteiro: tarifas em NANOusd por token e resultados em microusd,
 * com arredondamento PARA CIMA — a reserva nunca sai menor que a conta.
 */
import { canonicalDigest } from './canonical-json.js';
import type { InferenceRequestV1, InferenceResponseV1, InferenceUsageObservedV1 } from './inference-gateway.js';

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
 * que já é o do grant.
 */
export function enforceOutputCap(
  request: InferenceRequestV1,
  cap: number,
): { ok: true; max_tokens: number } | { ok: false } {
  if (request.max_tokens === undefined) return { ok: true, max_tokens: cap };
  if (request.max_tokens > cap) return { ok: false };
  return { ok: true, max_tokens: request.max_tokens };
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
    nano(usage.prompt_tokens, 'prompt_tokens') * nano(tariff.input_nanousd_per_token, 'input_rate') +
    nano(usage.completion_tokens, 'completion_tokens') *
      nano(tariff.output_nanousd_per_token, 'output_rate');
  return ceilMicro(total);
}

// ─── resposta ───────────────────────────────────────────────────────────────

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
    const message: Record<string, unknown> = { role: m.role, content: m.content ?? null };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      message.tool_calls = m.tool_calls.map((tc: unknown) =>
        isObj(tc) && isObj(tc.function)
          ? {
              id: tc.id,
              type: tc.type,
              function: { name: tc.function.name, arguments: tc.function.arguments },
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
  const u = raw.usage;
  if (
    isObj(u) &&
    typeof u.prompt_tokens === 'number' &&
    typeof u.completion_tokens === 'number' &&
    typeof u.total_tokens === 'number'
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
              function: { name: tc.function.name, arguments: tc.function.arguments },
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

function isPrivateAddress(addr: string): boolean {
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (a === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) {
    const o1 = Number(v4[1]);
    const o2 = Number(v4[2]);
    return (
      o1 === 127 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)
    );
  }
  // IPv6 unique local (fc00::/7).
  return /^f[cd][0-9a-f]{2}:/i.test(a);
}

/**
 * A rota não é pública (§9.1). Qualquer cabeçalho de proxy significa que a
 * requisição atravessou o proxy da borda — e a borda publica o host inteiro.
 * Sem cabeçalho de proxy, só endereço de loopback ou de rede privada.
 */
export function isInternalRequest(input: {
  remote_address: string | undefined;
  headers: Readonly<Record<string, unknown>>;
}): boolean {
  for (const h of PROXY_HEADERS) {
    if (input.headers[h] !== undefined) return false;
  }
  return typeof input.remote_address === 'string' && isPrivateAddress(input.remote_address);
}
