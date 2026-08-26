/**
 * Jornada — TRAVA DE ARQUITETURA (P8.5; saiu da quarentena na #623).
 *
 * O que ela prova, contra o console CONSTRUÍDO e um banco semeado:
 *   - proposta com trava exibe o banner da trava;
 *   - papel não-founder tem aprovar/rejeitar DESABILITADOS;
 *   - founder vê o banner na variante "prossiga com autoridade de founder" e
 *     os botões HABILITADOS.
 *
 * A trava não é escrita na fixture: ela é DERIVADA de `proposed_spec`
 * (`architecture_locks`) por `src/db/capability-risk.ts`, o mesmo caminho de
 * produção. Ver `scripts/seed-admin-ui-e2e-fixtures.ts`.
 *
 * Jornada de LEITURA: não muta nada, então não precisa restaurar fixture.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import { PROPOSTAS_E2E } from './_apoio/fixtures.js';

const TRAVADA = `/proposals/${PROPOSTAS_E2E.travada}`;
const PERIGOSA = `/proposals/${PROPOSTAS_E2E.perigosa}`;

test.describe('Trava de arquitetura', () => {
  test('banner da trava aparece na proposta travada', async ({ page, context }) => {
    await autenticarComo(context, 'owner');
    await page.goto(TRAVADA);
    await expect(
      page.getByText('Trava de arquitetura — aprovação de founder obrigatória'),
    ).toBeVisible();
    // A trava semeada, escrita por extenso: sem esta asserção o banner poderia
    // estar aparecendo por qualquer outro motivo.
    // `exact` porque o diff da proposta também imprime o spec cru, onde a
    // mesma string aparece — o que se afirma é o item da LISTA de travas.
    await expect(page.getByText('soul_immutable_core', { exact: true })).toBeVisible();
  });

  test('aprovar e rejeitar ficam desabilitados para papel não-founder', async ({
    page,
    context,
  }) => {
    await autenticarComo(context, 'owner');
    await page.goto(TRAVADA);
    await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Rejeitar', exact: true })).toBeDisabled();
    await expect(
      page.getByText('Propostas com trava de arquitetura exigem o papel founder.'),
    ).toBeVisible();
  });

  test('trava vinda da CLASSE de aprovação bloqueia igual à do spec', async ({
    page,
    context,
  }) => {
    // Regressão da #623. A fixture não declara trava nenhuma no spec: a trava
    // é da classe `capability_dangerous_tool` (`architectureLocks:
    // ['tool_blast_radius']` na matriz). A tela lia `proposal.locks` (só as
    // derivadas do spec) enquanto `proposals.approve` aplicava a UNIÃO —
    // então o botão vinha habilitado e o clique voltava
    // `FORBIDDEN: Architecture-lock proposals require founder role` dentro do
    // modal. Este caso é o que fica VERMELHO se alguém desfizer a correção.
    await autenticarComo(context, 'owner');
    await page.goto(PERIGOSA);
    await expect(page.getByText('tool_blast_radius', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeDisabled();
  });

  test('founder vê a variante de autoridade e decide', async ({ page, context }) => {
    await autenticarComo(context, 'founder');
    await page.goto(TRAVADA);
    await expect(
      page.getByText('Trava de arquitetura — prossiga com autoridade de founder'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Rejeitar', exact: true })).toBeEnabled();
  });
});
