/**
 * Jornada — APROVAÇÃO DUPLA, Tela 2 (P8.5; saiu da quarentena na #623).
 *
 * A fixture é de classe `capability_dangerous_tool`: `capability_type: 'tool'`
 * (piso de risco `critical`) com o marcador `has_side_effects`. A matriz exige
 * `owner` + `compliance_officer` distintos e SEM trava de arquitetura — a
 * trava é a outra jornada, e misturar as duas mediria a errada.
 *
 * A primeira aprovação NÃO ativa: o estado final afirmado aqui é exatamente
 * uma assinatura registrada e a fonte de verdade AINDA pendente.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import {
  PROPOSTAS_E2E,
  aprovacoesDaProposta,
  restaurarPropostas,
  statusDaProposta,
} from './_apoio/fixtures.js';

const DETALHE = `/proposals/${PROPOSTAS_E2E.dupla}`;

test.describe('Aprovação de proposta — dupla', () => {
  test.beforeEach(async ({ context }) => {
    await restaurarPropostas([PROPOSTAS_E2E.dupla]);
    await autenticarComo(context, 'owner');
  });

  test('a classe de risco exibe o banner de aprovação dupla', async ({ page }) => {
    await page.goto(DETALHE);
    await expect(page.getByText('Aprovação dupla obrigatória')).toBeVisible();
    await expect(page.getByText('owner + compliance_officer')).toBeVisible();
  });

  test('a primeira aprovação registra 1 de 2 e NÃO ativa a proposta', async ({ page }) => {
    await page.goto(DETALHE);
    await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
    await page.locator('textarea').fill('Owner aprova; aguarda o compliance officer.');
    await page.getByRole('button', { name: 'Confirmar aprovação' }).click();

    await expect(page.getByText('1 de 2 aprovações')).toBeVisible();

    const aprovacoes = await aprovacoesDaProposta(PROPOSTAS_E2E.dupla);
    expect(aprovacoes.map((a) => a.approver_role)).toEqual(['owner']);
    // O invariante que importa: a segunda assinatura ainda não existe, então a
    // fonte de verdade continua pendente (`submitted`), não `approved`.
    expect(await statusDaProposta(PROPOSTAS_E2E.dupla)).toBe('submitted');
  });
});
