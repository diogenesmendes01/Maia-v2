/**
 * Jornada — APROVAÇÃO DE PROPOSTA, papel único, Tela 2 (P8.5; saiu da
 * quarentena na #623).
 *
 * A fixture é de classe `capability_safe_tool` (risco baixo, sem trava), cuja
 * matriz exige só `owner` — ver `src/admin-ui/lib/approval-matrix.ts`.
 *
 * O caso de aprovação MUTA: restaura a fixture antes, e afirma o estado FINAL
 * de forma absoluta (uma aprovação, uma linha de trilha), nunca por delta.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import {
  PROPOSTAS_E2E,
  aprovacoesDaProposta,
  auditoriaDaProposta,
  restaurarPropostas,
} from './_apoio/fixtures.js';

const DETALHE = `/proposals/${PROPOSTAS_E2E.simples}`;

test.describe('Aprovação de proposta — papel único', () => {
  test.beforeEach(async ({ context }) => {
    await restaurarPropostas([PROPOSTAS_E2E.simples]);
    await autenticarComo(context, 'owner');
  });

  test('o detalhe renderiza cabeçalho e diff', async ({ page }) => {
    await page.goto(DETALHE);
    // O h1 é o DESCRITOR da proposta. Antes da #623 este caso afirmava só que
    // existia um `h1` — e passava contra o título da tela de login.
    await expect(page.locator('h1')).toContainText('Jornada E2E — proposta simples');
    await expect(page.getByText('capability_safe_tool').first()).toBeVisible();
  });

  test('aprovar fecha o modal e registra a decisão', async ({ page }) => {
    await page.goto(DETALHE);
    await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
    await expect(page.getByText('Aprovar proposta?')).toBeVisible();
    await page.locator('textarea').fill('Aprovada após revisão dos artefatos impactados.');
    await page.getByRole('button', { name: 'Confirmar aprovação' }).click();
    await expect(page.getByText('Aprovar proposta?')).toBeHidden();

    const aprovacoes = await aprovacoesDaProposta(PROPOSTAS_E2E.simples);
    expect(aprovacoes.map((a) => a.decision)).toEqual(['approved']);
    expect(aprovacoes[0]?.approver_role).toBe('owner');
    expect((await auditoriaDaProposta(PROPOSTAS_E2E.simples)).map((l) => l.action)).toEqual([
      'proposal_approve',
    ]);
  });

  test('rejeitar exige comentário de pelo menos 10 caracteres', async ({ page }) => {
    await page.goto(DETALHE);
    await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await page.locator('textarea').fill('no');
    await page.getByRole('button', { name: 'Confirmar rejeição' }).click();
    await expect(page.getByText('pelo menos 10 caracteres')).toBeVisible();
    // O guard é do CLIENTE, mas o que importa é que nada foi decidido: sem
    // esta asserção, uma validação que "avisa e envia mesmo assim" passaria.
    expect(await aprovacoesDaProposta(PROPOSTAS_E2E.simples)).toEqual([]);
  });
});
