/**
 * Issue #518 — rate limit para procedures tRPC do console.
 *
 * O console não tinha NENHUM: `@fastify/rate-limit` protege o `/setup` do
 * runtime, mas as procedures do admin eram ilimitadas. Operações de
 * pareamento precisam de limite por definição — cada `startPairing` abre um
 * socket WhatsApp e conta contra os limites do próprio WhatsApp, e um loop de
 * retry (bug de UI ou credencial de operador vazada) queimaria a linha.
 *
 * Implementação deliberadamente MÍNIMA: janela fixa em memória, sem Redis. O
 * admin-ui é um processo Postgres-only; introduzir Redis só para isto
 * ampliaria a superfície de deploy. Consequência honesta e documentada: com N
 * réplicas do console o limite efetivo é N×max. Isso é aceitável porque o
 * limite é uma trava anti-abuso/anti-loop, e a trava DURA de concorrência é o
 * `pairing_in_progress` no Postgres (uma tentativa viva por canal, decidida
 * numa transação com `FOR UPDATE`) — essa sim é global.
 *
 * Fail-CLOSED: estourar o limite lança `TOO_MANY_REQUESTS`; nunca degrada
 * para "deixa passar".
 */
import { TRPCError } from '@trpc/server';

export interface RateLimitRule {
  /** Máximo de chamadas permitidas na janela. */
  max: number;
  /** Tamanho da janela em milissegundos. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Poda preguiçosa: sem um sweeper, um console de vida longa acumularia um
 * bucket por (ator, canal) já expirado. Roda a cada N chamadas, O(n) sobre um
 * mapa pequeno.
 */
const PRUNE_EVERY = 500;
let callsSincePrune = 0;

function prune(now: number): void {
  callsSincePrune += 1;
  if (callsSincePrune < PRUNE_EVERY) return;
  callsSincePrune = 0;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * Consome uma unidade do bucket `key`. Lança `TOO_MANY_REQUESTS` quando
 * estoura, com `retry_after_s` na mensagem para a UI conseguir orientar.
 */
export function assertRateLimit(key: string, rule: RateLimitRule): void {
  const now = Date.now();
  prune(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return;
  }
  if (existing.count >= rule.max) {
    const retryAfterS = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Limite de ${rule.max} operações atingido. Tente novamente em ${retryAfterS}s.`,
    });
  }
  existing.count += 1;
}

/** Test-only. */
export function _resetRateLimitForTests(): void {
  buckets.clear();
  callsSincePrune = 0;
}
