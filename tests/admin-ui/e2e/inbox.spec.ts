/**
 * Jornada — INBOX DE APROVAÇÕES, Tela 1 (P8.5; saiu da quarentena na #623).
 *
 * A fila do operador contra o console CONSTRUÍDO e o banco semeado por
 * `scripts/seed-admin-ui-e2e-fixtures.ts`: cabeçalho, contador, filtro por
 * tipo, navegação para o detalhe e a barra de ação em lote.
 *
 * ── Uma correção de seletor que vale explicação ──────────────────────────
 * O caso "filtro por tipo" clicava em `Regra de política` e esperava linhas.
 * Ele NUNCA poderia passar: a fila unificada só federa DUAS fontes hoje
 * (`capability_proposals` e `agent_operational_profile_versions` — ver o
 * comentário "Future tables" em `src/db/repositories/admin-repos.ts`), então
 * o tipo `policy_rule` tem contador mas não tem linha. O caso agora afirma as
 * DUAS metades do comportamento real: filtrar por um tipo COM fonte mostra
 * linhas, filtrar por um tipo SEM fonte mostra o estado vazio.
 *
 * Jornada de LEITURA: nenhum caso aqui muta proposta.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import { TODAS_AS_PROPOSTAS, restaurarPropostas } from './_apoio/fixtures.js';

test.describe('Inbox — Tela 1', () => {
  test.beforeEach(async ({ context }) => {
    // A fila é um AGREGADO: ela enxerga as fixtures que as outras jornadas
    // aprovam e rejeitam. Restaurar TODAS aqui é o que torna o contador e a
    // tabela independentes da ordem de execução — sem isso, este arquivo
    // passaria ou não conforme quem rodou antes, que é pior que ficar em
    // quarentena.
    await restaurarPropostas(TODAS_AS_PROPOSTAS);
    await autenticarComo(context, 'owner');
  });

  test('carrega a fila e mostra o cabeçalho', async ({ page }) => {
    await page.goto('/inbox');
    await expect(page.locator('h1')).toContainText('Aprovações');
  });

  test('o contador do cabeçalho reflete as propostas pendentes', async ({ page }) => {
    await page.goto('/inbox');
    // O `beforeEach` acabou de devolver TODAS as fixtures ao estado pendente,
    // então o piso é a contagem delas. É um piso e não uma igualdade porque o
    // badge soma todas as fontes da fila — outra linha pendente no banco não
    // torna a afirmação falsa.
    const badge = page.getByText(/^\d+ pendentes?$/);
    await expect(badge).toBeVisible();
    const texto = (await badge.innerText()).trim();
    expect(Number.parseInt(texto, 10)).toBeGreaterThanOrEqual(TODAS_AS_PROPOSTAS.length);
  });

  test('filtrar por tipo muda a tabela', async ({ page }) => {
    await page.goto('/inbox');
    const linhas = page.locator('table tbody tr');
    await expect(linhas.first()).toBeVisible();

    // Tipo COM fonte federada: as fixtures aparecem.
    await page.getByRole('button', { name: /^Capacidade/ }).click();
    await expect(
      page.getByRole('cell', { name: 'Jornada E2E — proposta simples', exact: true }),
    ).toBeVisible();

    // Tipo SEM fonte federada: estado vazio, não linhas de outro tipo.
    await page.getByRole('button', { name: /^Capacidade/ }).click();
    await page.getByRole('button', { name: /^Regra de política/ }).click();
    await expect(page.getByText('Nenhuma proposta pendente')).toBeVisible();
  });

  test('clicar numa proposta abre o detalhe', async ({ page }) => {
    await page.goto('/inbox');
    await page
      .getByRole('row')
      .filter({ hasText: 'Jornada E2E — proposta simples' })
      .click();
    await expect(page).toHaveURL(/\/proposals\/[0-9a-f-]{36}$/);
    await expect(page.locator('h1')).toContainText('Jornada E2E — proposta simples');
  });

  test('a barra de rejeição em massa só existe com seleção', async ({ page }) => {
    await page.goto('/inbox');
    // Anti-vacuidade: sem esta linha o "não visível" abaixo passaria numa
    // tela vazia (foi assim que este caso ficou verde contra o /auth/signin).
    await expect(page.getByRole('checkbox', { name: 'Selecionar todas' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rejeitar em massa' })).toBeHidden();

    await page
      .getByRole('checkbox', { name: 'Selecionar Jornada E2E — proposta simples' })
      .check();
    await expect(page.getByRole('button', { name: 'Rejeitar em massa' })).toBeVisible();
  });
});
