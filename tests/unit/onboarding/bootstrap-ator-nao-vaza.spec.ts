import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #519 — o ator `founder` do bootstrap NÃO atravessa a fronteira do módulo.
 *
 * O PRIVILÉGIO EM JOGO. Os passos da saga exigem um `OnboardingActor`, e o do
 * bootstrap tem papel `founder` — o maior do sistema, o único global, o único
 * que `assertMayMutate` deixa passar com `tenant_id: null`. `runGlobalBootstrap()`
 * o constrói e o consome inteiramente dentro de `src/onboarding/wizard.ts`; a
 * rota recebe ids de volta, nunca o ator.
 *
 * O QUE ESTE GUARD IMPEDE. Uma refatoração aparentemente inocente — "a rota já
 * sabe o `run_id`, deixa ela chamar `executeOnboardingStep` direto" — obriga a
 * rota a montar um ator. E o único ator que funciona ali é `founder` com
 * `tenant_id: null`. A partir daí a superfície HTTP segura uma credencial de
 * privilégio máximo utilizável para QUALQUER comando da saga, não só para os
 * dois passos do bootstrap.
 *
 * Nenhum teste de comportamento pegaria: o bootstrap continuaria funcionando
 * exatamente igual. É a mesma classe da #673 (fiação arrancável em silêncio) e
 * do guard de `openRunChecked` (#677) — o código certo podendo virar errado sem
 * ninguém notar.
 *
 * Registrei este risco nas Reviewer Notes da #679 e NÃO escrevi o guard na
 * hora. Este arquivo conserta essa omissão.
 */

const ROTA = join(process.cwd(), 'src/setup/index.ts');
const rota = (): string => readFileSync(ROTA, 'utf8');

describe('#519 — o ator founder não vaza para a superfície HTTP', () => {
  it('a rota de bootstrap existe (âncora anti-vacuidade)', () => {
    // Sem isto, remover a rota faria as asserções de baixo passarem VAZIAS.
    expect(rota()).toMatch(/'\/setup\/bootstrap'/);
    expect(rota()).toMatch(/runGlobalBootstrap/);
  });

  it('a rota NÃO monta um OnboardingActor', () => {
    const s = rota();
    expect(
      /actor_role\s*:/.test(s),
      'a rota passou a montar um ator. O único que funciona nos passos do ' +
        'bootstrap é `founder` com tenant_id null — privilégio máximo, global. ' +
        'O ciclo inteiro deve ficar em runGlobalBootstrap(), que o constrói e ' +
        'o consome sem devolvê-lo.',
    ).toBe(false);
    expect(
      /\bOnboardingActor\b/.test(s),
      'a rota importou o tipo OnboardingActor — sinal de que vai montar um.',
    ).toBe(false);
  });

  it('a rota NÃO executa passos da saga diretamente', () => {
    expect(
      /executeOnboardingStep/.test(rota()),
      'a rota passou a chamar executeOnboardingStep. Isso exige um ator, e o ' +
        'ator do bootstrap é founder. Use runGlobalBootstrap(), que faz o ciclo ' +
        'inteiro dentro do módulo.',
    ).toBe(false);
  });

  it('`runGlobalBootstrap` não devolve o ator no seu contrato de saída', () => {
    const wizard = readFileSync(join(process.cwd(), 'src/onboarding/wizard.ts'), 'utf8');
    const ini = wizard.indexOf('export type RunGlobalBootstrapOutcome = {');
    expect(ini, 'RunGlobalBootstrapOutcome não encontrado').toBeGreaterThan(-1);
    const bloco = wizard.slice(ini, wizard.indexOf('};', ini));
    expect(
      /actor|role/i.test(bloco),
      'o contrato de saída de runGlobalBootstrap passou a expor ator ou papel. ' +
        'Ele devolve ids — run_id, tenant_id, founder_user_id — e nada mais.',
    ).toBe(false);
  });
});
