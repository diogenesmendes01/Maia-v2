/**
 * P8.5 — Tela 4 (Drift & Incidents) E2E tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Drift & Incidents — Tela 4', () => {
  test('loads drift page with all 3 incident cards', async ({ page }) => {
    await page.goto('http://localhost:4000/drift');
    await expect(page.locator('h1')).toContainText('Drift');
    await expect(page.locator('text=Bloqueios PEP')).toBeVisible();
    await expect(page.locator('text=Alertas de orçamento')).toBeVisible();
    await expect(page.locator('text=Alertas de regressão')).toBeVisible();
  });
});
