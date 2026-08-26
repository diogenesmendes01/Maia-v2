/**
 * Jornada — DRIFT E INCIDENTES, Tela 4 (P8.5; saiu da quarentena na #623).
 *
 * Só leitura: os três cartões de incidente existem mesmo com zero incidentes
 * (o valor é o contador), então a jornada vale contra o banco semeado sem
 * fixture própria. Sem sessão ela media a tela de login — era essa, e só
 * essa, a causa da quarentena.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';

test.describe('Drift e incidentes — Tela 4', () => {
  test('a tela carrega com os três cartões de incidente', async ({ page, context }) => {
    await autenticarComo(context, 'owner');
    await page.goto('/drift');
    await expect(page.locator('h1')).toContainText('Drift');
    await expect(page.getByText('Bloqueios PEP')).toBeVisible();
    await expect(page.getByText('Alertas de orçamento')).toBeVisible();
    await expect(page.getByText('Alertas de regressão')).toBeVisible();
  });
});
