/**
 * P06 (spec §9.1 "Autenticação", §9.2) — a credencial curta de inferência de
 * um run: como nasce, como vira hash, e a superfície de tools que ela autoriza.
 *
 * O token tem entropia criptográfica (256 bits) e só existe em memória: no
 * banco fica a sha256 (`engine_inference_grants.token_hash`), e o filho o
 * recebe pelo env do spawn como `api_key` do SDK. Nunca por frame, prompt,
 * schema ou log.
 */
import { createHash, randomBytes } from 'node:crypto';
import { canonicalDigest } from './canonical-json.js';

/** Público a que todo grant de inferência é emitido e contra o qual é conferido. */
export const INFERENCE_GRANT_AUDIENCE = 'maia.hermes.inference.v1';

const FORBIDDEN_TOOL_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const TOKEN_PREFIX = 'mhi1_';
const TOKEN_RE = /^mhi1_[A-Za-z0-9_-]{43}$/;

/** Token novo. Só a hash dele pode ser persistida. */
export function mintInferenceToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Forma do token, sem consultar nada. Falhar aqui é 401 sem ir ao banco. */
export function isWellFormedInferenceToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function hashInferenceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * `Authorization: Bearer <token>` → token, ou `null`. Qualquer outra forma é
 * credencial ausente.
 */
export function bearerTokenOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  return m?.[1] ?? null;
}

/**
 * A superfície que o grant autoriza: nome da tool → digest canônico do
 * `input_schema`. É o que permite conferir nomes E schemas (§9.1 validação 4).
 * Lança se um schema não for JSON canônico — quem emite o grant não pode
 * emitir superfície que o gateway não conseguiria conferir.
 */
export function toolSurfaceOf(
  tools: ReadonlyArray<{ name: string; input_schema: Record<string, unknown> }>,
): Record<string, string> {
  const surface = new Map<string, string>();
  for (const t of tools) {
    // Nome que colide com a maquinaria de objeto do JS não vira chave de mapa.
    if (FORBIDDEN_TOOL_KEYS.has(t.name)) {
      throw new TypeError('toolSurfaceOf: nome de tool reservado');
    }
    if (surface.has(t.name)) throw new TypeError('toolSurfaceOf: tool repetida');
    surface.set(t.name, canonicalDigest(t.input_schema));
  }
  return Object.fromEntries(surface);
}
