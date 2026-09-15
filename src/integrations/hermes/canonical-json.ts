/**
 * P00 (spec §5.3.4, §5.6.2, §6.5.4) — SERIALIZAÇÃO CANÔNICA VERSIONADA.
 *
 * Existe para uma coisa só: dois bytes diferentes que representam o MESMO
 * conteúdo lógico precisam produzir o MESMO digest, e qualquer coisa que não
 * seja JSON puro precisa FALHAR em vez de virar `null` silenciosamente.
 *
 * Por que não `JSON.stringify` direto:
 *
 *  - ordem de chaves. `{a:1,b:2}` e `{b:2,a:1}` geram bytes diferentes e
 *    digests diferentes. O `request_key` da spec exige que o REENVIO do mesmo
 *    pedido mantenha o hash (§5.6.1); um objeto remontado noutra ordem viraria
 *    "mesma chave com bytes diferentes", que a spec classifica como conflito
 *    terminal. O bug seria fabricado pela serialização, não pelo pedido.
 *  - silêncio. `JSON.stringify` transforma `undefined` em chave omitida,
 *    `Date` em string, `NaN`/`Infinity` em `null` e lança só em ciclo e
 *    `BigInt`. Para um hash de identidade, cada uma dessas conversões é uma
 *    colisão em potencial entre dois pedidos distintos.
 *
 * Por isso aqui tudo que não é `null | boolean | number finito | string |
 * array | objeto simples` é ERRO TIPADO. A spec §5.3.4 enumera exatamente
 * esses casos ("valores JSON não admitem `undefined`, funções, `NaN`,
 * `Infinity`, BigInt, `Map`, Date ou ciclos").
 *
 * `__proto__`/`constructor`/`prototype` são recusadas como chave em qualquer
 * profundidade: o payload vem de um processo que roda um motor de terceiros, e
 * um objeto com essas chaves atravessando `Object.assign`/spread num consumidor
 * futuro é poluição de protótipo. Recusar na fronteira é mais barato do que
 * auditar todo consumidor.
 */
import { createHash } from 'node:crypto';

export type CanonicalJsonErrorCode =
  | 'non_finite'
  | 'unsupported_type'
  | 'cycle'
  | 'forbidden_key';

export class CanonicalJsonError extends Error {
  constructor(
    readonly code: CanonicalJsonErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** Chaves que nunca atravessam a fronteira, em qualquer profundidade. */
export const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Versão do algoritmo. Muda junto com QUALQUER mudança de bytes emitidos. */
export const CANONICAL_JSON_VERSION = 1 as const;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, seen: Set<object>, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          'non_finite',
          path,
          `valor numérico não finito em ${path}: JSON não representa NaN/Infinity`,
        );
      }
      // `-0` e `0` são o mesmo valor lógico; `JSON.stringify(-0)` já emite "0".
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalJsonError(
        'unsupported_type',
        path,
        `tipo não serializável (${typeof value}) em ${path}`,
      );
    case 'object':
      break;
    default:
      throw new CanonicalJsonError('unsupported_type', path, `tipo desconhecido em ${path}`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError('cycle', path, `referência cíclica em ${path}`);
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      out.push('[');
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) out.push(',');
        // `[ ,1]` (buraco) e `[undefined]` viram erro, não `null`.
        encode(obj[i], `${path}[${i}]`, seen, out);
      }
      out.push(']');
      return;
    }

    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError(
        'unsupported_type',
        path,
        `objeto não-simples (${obj.constructor?.name ?? 'sem protótipo'}) em ${path}`,
      );
    }

    // `Object.keys` já ignora símbolos e não-enumeráveis; a ordenação é por
    // unidade de código UTF-16, determinística em qualquer runtime.
    const keys = Object.keys(obj).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        throw new CanonicalJsonError(
          'forbidden_key',
          `${path}.${key}`,
          `chave proibida "${key}" em ${path}`,
        );
      }
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key), ':');
      encode((obj as Record<string, unknown>)[key], `${path}.${key}`, seen, out);
    }
    out.push('}');
  } finally {
    seen.delete(obj);
  }
}

/**
 * Bytes canônicos do valor. Lança `CanonicalJsonError` (com código) para
 * qualquer coisa fora do domínio JSON.
 */
export function canonicalJsonStringify(value: unknown): string {
  const out: string[] = [];
  encode(value, '$', new Set<object>(), out);
  return out.join('');
}

/**
 * Digest de identidade. Prefixado pela versão do algoritmo: se um dia a
 * canonicalização mudar, os digests antigos não passam a "bater por acaso" com
 * os novos — a diferença fica explícita no valor.
 */
export function canonicalDigest(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  return createHash('sha256')
    .update(`maia.canonical-json/v${CANONICAL_JSON_VERSION}\n`, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

/** Tamanho em bytes UTF-8 da forma canônica (para os tetos do §5.3.4). */
export function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJsonStringify(value), 'utf8');
}
