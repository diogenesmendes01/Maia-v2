/**
 * Jornada — REJEIÇÃO DE PROPOSTA (P8.5; saiu da quarentena na #623).
 *
 * Antes da #623 este caso terminava num comentário ("Verify rejection
 * persisted") e não afirmava nada. Agora afirma o estado FINAL: a fonte de
 * verdade em `rejected`, uma assinatura de rejeição com o comentário digitado.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import {
  PROPOSTAS_E2E,
  aprovacoesDaProposta,
  restaurarPropostas,
  statusDaProposta,
} from './_apoio/fixtures.js';

const MOTIVO = 'Fora do escopo do trimestre; revisitar no Q3.';

test.describe('Rejeição de proposta', () => {
  test('rejeitar registra comentário e leva a fonte de verdade a rejected', async ({
    page,
    context,
  }) => {
    await restaurarPropostas([PROPOSTAS_E2E.rejeicao]);
    await autenticarComo(context, 'owner');

    await page.goto(`/proposals/${PROPOSTAS_E2E.rejeicao}`);
    await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await page.locator('textarea').fill(MOTIVO);
    await page.getByRole('button', { name: 'Confirmar rejeição' }).click();
    await expect(page.getByText('Rejeitar proposta?')).toBeHidden();

    expect(await statusDaProposta(PROPOSTAS_E2E.rejeicao)).toBe('rejected');
    const aprovacoes = await aprovacoesDaProposta(PROPOSTAS_E2E.rejeicao);
    expect(aprovacoes.map((a) => a.decision)).toEqual(['rejected']);
    expect(aprovacoes[0]?.comment).toBe(MOTIVO);
  });
});
