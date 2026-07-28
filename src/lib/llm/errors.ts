/**
 * Taxonomia única de erros do LLM Gateway (issue #508).
 *
 * Antes desta issue cada provider vazava seu próprio formato de erro e o
 * wrapper retentava tudo indiscriminadamente (`src/lib/claude.ts` pré-#508
 * retentava até erro 401). Aqui a decisão de retry é derivada do KIND, e o
 * kind é derivado de forma provider-agnóstica.
 *
 * Invariante de segurança: nenhuma mensagem construída aqui pode conter chave
 * de API, header `Authorization`, prompt ou resposta crua. `redactErrorText`
 * é a única porta por onde texto de provider entra num erro/log.
 */

export type LLMErrorKind =
  | 'authentication'
  | 'permission'
  | 'invalid_request'
  | 'rate_limit'
  | 'provider_5xx'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'response_invalid'
  | 'budget_exhausted'
  | 'configuration';

/**
 * Só erros TRANSITÓRIOS são retentáveis. `aborted` e `timeout` ficam de fora
 * de propósito: cancelamento não é falha do provider e retentar depois do
 * deadline é exatamente o retry storm que a issue quer matar.
 */
const RETRYABLE: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  'rate_limit',
  'provider_5xx',
  'network',
]);

export function isRetryableKind(kind: LLMErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/** Padrões de segredo que nunca podem sair em log/trace/erro. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-or-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g,
  /("|')?(x-api-key|authorization|api[_-]?key)("|')?\s*[:=]\s*("|')?[^"'\s,}]+/gi,
];

const MAX_ERROR_TEXT = 200;

/**
 * Redige e trunca texto vindo do provider. Truncar importa tanto quanto
 * redigir: um corpo de erro 400 do provider costuma ecoar parte do prompt, e
 * prompt é PII neste produto.
 */
export function redactErrorText(input: unknown): string {
  const raw =
    typeof input === 'string'
      ? input
      : input && typeof input === 'object' && typeof (input as { message?: unknown }).message === 'string'
        ? ((input as { message: string }).message)
        : String(input ?? '');
  let out = raw;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}…` : out;
}

export type LLMGatewayErrorInit = {
  kind: LLMErrorKind;
  /** Texto JÁ redigido, ou o erro do provider (será redigido aqui). */
  detail?: unknown;
  status?: number;
  retry_after_ms?: number;
  provider?: string;
  model?: string;
  workload?: string;
  cause?: unknown;
};

export class LLMGatewayError extends Error {
  readonly code = 'LLM_GATEWAY_ERROR';
  readonly kind: LLMErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retry_after_ms?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly workload?: string;

  constructor(init: LLMGatewayErrorInit) {
    const detail = init.detail === undefined ? '' : redactErrorText(init.detail);
    super(detail ? `llm_gateway_${init.kind}: ${detail}` : `llm_gateway_${init.kind}`);
    this.name = 'LLMGatewayError';
    this.kind = init.kind;
    this.retryable = isRetryableKind(init.kind);
    this.status = init.status;
    this.retry_after_ms = init.retry_after_ms;
    this.provider = init.provider;
    this.model = init.model;
    this.workload = init.workload;
    if (init.cause !== undefined) {
      // `cause` fica disponível pra debug local, mas nunca é serializado nos
      // logs do gateway (ver telemetry.ts) — só o kind + detalhe redigido.
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/**
 * Detecta abort vindo do SDK. Anthropic e OpenAI levantam
 * `APIUserAbortError` (`name === 'AbortError'`); `fetch` nativo levanta
 * `DOMException` com o mesmo `name`. Checamos por nome pra ficar
 * provider-agnóstico (herdado do fix da issue #220).
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError') return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /timed?\s*out/i.test(msg);
}

function readHeader(err: unknown, header: string): string | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  // SDKs modernos expõem `Headers`; versões antigas expõem objeto plano.
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(header) ?? undefined;
  }
  const rec = headers as Record<string, unknown>;
  const hit = rec[header] ?? rec[header.toLowerCase()];
  return typeof hit === 'string' ? hit : undefined;
}

/**
 * `Retry-After` aceita segundos (`"30"`) ou HTTP-date. Ambos são respeitados;
 * valores absurdos são descartados (um provider mal comportado não pode
 * segurar um turno por meia hora).
 */
const MAX_RETRY_AFTER_MS = 60_000;

export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (!Number.isFinite(ms) || ms < 0) return undefined;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Classifica um erro arbitrário de provider num `LLMGatewayError`.
 *
 * Default deliberado: erro SEM status HTTP conhecido e que não seja abort vira
 * `network` (retentável). Isso preserva o comportamento pré-#508 (que
 * retentava qualquer throw) para falhas opacas, enquanto os status conhecidos
 * (401/403/400/404/422) passam a ser terminais de primeira.
 */
export function classifyProviderError(
  err: unknown,
  meta: { provider?: string; model?: string; workload?: string } = {},
): LLMGatewayError {
  if (err instanceof LLMGatewayError) return err;

  if (isAbortError(err)) {
    return new LLMGatewayError({ kind: 'aborted', detail: err, cause: err, ...meta });
  }
  if (isTimeoutError(err)) {
    return new LLMGatewayError({ kind: 'timeout', detail: err, cause: err, ...meta });
  }

  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    const retryAfter = parseRetryAfterMs(readHeader(err, 'retry-after'));
    let kind: LLMErrorKind;
    if (status === 401) kind = 'authentication';
    else if (status === 403) kind = 'permission';
    else if (status === 429) kind = 'rate_limit';
    else if (status >= 500) kind = 'provider_5xx';
    else if (status === 408) kind = 'timeout';
    else kind = 'invalid_request';
    return new LLMGatewayError({
      kind,
      detail: err,
      status,
      retry_after_ms: retryAfter,
      cause: err,
      ...meta,
    });
  }

  return new LLMGatewayError({ kind: 'network', detail: err, cause: err, ...meta });
}
