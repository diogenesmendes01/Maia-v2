/**
 * Jornada — VERSÕES E ROLLBACK, Tela 3 (P8.5; saiu da quarentena na #623).
 *
 * O segundo caso deste arquivo era um esqueleto vazio ("Skeleton — wires up
 * once data is seeded"), isto é, uma jornada que passava sem afirmar nada.
 * Com as duas versões de perfil semeadas ele afirma a regra que dá nome ao
 * caso: `Reverter` é oferecido para a versão ANTERIOR à ativa e não para a
 * própria ativa (`validateRollbackTarget`, `src/admin-ui/lib/rollback-targets.ts`).
 *
 * A reversão em si NÃO é executada: ela mutaria o ponteiro ativo do agente e
 * a jornada passaria a depender da ordem de execução. O que se afirma aqui é
 * o gate de alvo — a parte que a tela decide.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';

test.describe('Versões e rollback — Tela 3', () => {
  test.beforeEach(async ({ context }) => {
    await autenticarComo(context, 'owner');
  });

  test('a tela carrega e lista as versões da fonte de verdade', async ({ page }) => {
    await page.goto('/versions');
    await expect(page.locator('h1')).toContainText('Versões');
    await expect(page.getByRole('cell', { name: 'v2', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'v1', exact: true })).toBeVisible();
  });

  test('reverter é oferecido só para versão anterior à ativa', async ({ page }) => {
    await page.goto('/versions');

    const linhaAtiva = page.getByRole('row').filter({ hasText: 'v2' });
    const linhaAnterior = page.getByRole('row').filter({ hasText: 'v1' });

    await expect(linhaAnterior.getByRole('button', { name: 'Reverter' })).toBeVisible();
    await expect(linhaAtiva.getByRole('button', { name: 'Reverter' })).toHaveCount(0);

    // O modal diz de qual versão para qual — é o que o operador confere antes
    // de confirmar uma reversão durante um incidente.
    await linhaAnterior.getByRole('button', { name: 'Reverter' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toContainText('Reverter versão');
    await expect(modal).toContainText('v2');
    await expect(modal).toContainText('v1');
  });
});
