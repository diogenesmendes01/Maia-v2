/**
 * Escopo de tenant para specs que exercitam módulos que chamam o LLM.
 *
 * Issue #508 (review rodada 1): o LLM Gateway passou a exigir
 * `tenant_id + agent_id` no ALS — uma chamada de modelo sempre gasta dinheiro
 * de algum tenant, consome a quota dele e produz evidência que precisa ser
 * correlacionada com ele. Sem contexto, a chamada é rejeitada com
 * `missing_tenant_context` antes de qualquer I/O.
 *
 * Vários specs chamavam esses módulos direto, sem contexto — o que só passava
 * porque o gateway era fail-open. Em produção o contexto sempre existe: os
 * detectores de drift rodam sob o fan-out de `src/cognition/drift/index.ts`,
 * o role selector sob o turno, o proposer sob o worker de gaps. Estes helpers
 * reproduzem essa realidade no teste em vez de exercitar um caminho que a
 * produção não tem.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';

/** Tenant/agent reais (não o literal `'default'`) para uso nos specs. */
export const TEST_LLM_SCOPE = { tenant_id: 'acme', agent_id: 'ana' } as const;

/** Roda `fn` sob o escopo de teste. */
export function inLLMScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ ...TEST_LLM_SCOPE }, fn);
}

/**
 * Envolve uma função assíncrona para que toda invocação rode sob o escopo.
 * Preserva a assinatura, então o spec pode substituir o símbolo importado e
 * deixar os call sites intactos.
 */
export function scopedFn<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => inLLMScope(() => fn(...args));
}

/** Idem, para um objeto `{ detect }` (a forma dos detectores de drift). */
export function scopedDetector<I, O>(d: { detect: (input: I) => Promise<O> }): {
  detect: (input: I) => Promise<O>;
} {
  return { detect: scopedFn(d.detect.bind(d)) };
}
