/**
 * Issue #519 §4 — idempotência dos comandos do wizard.
 *
 * O contrato tem três peças e cada uma resolve um modo de falha distinto:
 *
 *  1. `hashIdempotencyKey` — a chave OPACA do cliente nunca é persistida em
 *     claro. Ela identifica a requisição do operador; guardá-la crua no banco
 *     faria dela um identificador rastreável a mais, e um vazamento do ledger
 *     permitiria forjar um replay. Persistimos só o SHA-256.
 *
 *  2. `hashPayload` — hash CANÔNICO do payload. Sem canonicalização, a mesma
 *     intenção enviada com as chaves JSON em outra ordem produziria outro hash
 *     e seria classificada como conflito; e, pior, uma intenção DIFERENTE
 *     poderia colidir com a anterior se comparássemos por igualdade rasa.
 *
 *  3. A comparação: MESMA chave + MESMO payload ⇒ replay (devolve o resultado
 *     persistido). MESMA chave + payload DIVERGENTE ⇒ `idempotency_payload_mismatch`
 *     — o cliente reciclou a chave para outra intenção, e responder o resultado
 *     antigo seria mentir sobre o que foi executado.
 *
 * A canonicalização ordena as chaves de objeto RECURSIVAMENTE e preserva a
 * ordem de arrays (em array, ordem É semântica: `granted_packs` em outra ordem
 * ainda é o mesmo conjunto, mas isso é uma normalização de DOMÍNIO e é feita
 * por quem monta o payload, não aqui). `undefined` é removido para que
 * `{a: 1}` e `{a: 1, b: undefined}` — indistinguíveis depois de um round-trip
 * JSON — produzam o mesmo hash.
 */
import { createHash } from 'node:crypto';
import { OnboardingError } from './errors.js';

/** Comprimento mínimo de uma chave de idempotência aceitável. */
const MIN_KEY_LENGTH = 8;

export function hashIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim().length < MIN_KEY_LENGTH) {
    throw new OnboardingError(
      'missing_idempotency_key',
      `idempotency key ausente ou curta demais (mínimo ${MIN_KEY_LENGTH} caracteres)`,
    );
  }
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * JSON canônico: chaves de objeto ordenadas recursivamente, `undefined`
 * removido. Exportado porque o fingerprint de configuração do readiness usa
 * exatamente a mesma função — dois hashes com regras diferentes divergiriam
 * silenciosamente.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'undefined') return null;
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export type IdempotencyDecision<TResult> =
  | { outcome: 'execute' }
  | { outcome: 'replay'; result: TResult }
  | { outcome: 'conflict' };

/**
 * A decisão, isolada e pura, para ser testável sem banco. `existing` é a linha
 * do ledger para (run, step, key_hash) — `null` quando ainda não existe.
 */
export function decideIdempotency<TResult>(input: {
  payload_hash: string;
  existing: { payload_hash: string; result: TResult } | null;
}): IdempotencyDecision<TResult> {
  if (!input.existing) return { outcome: 'execute' };
  if (input.existing.payload_hash !== input.payload_hash) return { outcome: 'conflict' };
  return { outcome: 'replay', result: input.existing.result };
}
