/**
 * FIXTURE do teste de regressão do reporter — não é `*.spec.ts` de propósito,
 * para o `include` da suíte não o coletar. Ele é executado por um vitest
 * filho, disparado por `diagnostico-reporter.spec.ts`.
 *
 * Um `beforeAll` que estoura é EXATAMENTE o modo de falha que a #545 criou ao
 * mover os imports frios para o hook. O reporter era cego para ele.
 */
import { describe, it, expect, beforeAll } from 'vitest';

describe('fixture: beforeAll que estoura', () => {
  beforeAll(async () => {
    await new Promise((r) => setTimeout(r, 200));
  }, 10);

  it('nunca chega a rodar', () => {
    expect(true).toBe(true);
  });
});
