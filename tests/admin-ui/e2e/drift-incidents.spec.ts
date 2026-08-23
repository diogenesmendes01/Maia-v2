/**
 * P8.5 — Tela 4 (Drift & Incidents) E2E tests.
 */
import { test, expect } from '@playwright/test';

// `@pendente-472`: fora do gate de CI (projeto `jornadas-pendentes` do
// playwright.config.ts). Esta spec exige sessão autenticada e fixtures que
// `scripts/seed-proposals-fixtures.ts` ainda não cria — ligá-la é a #472. A
// lista de arquivos em quarentena é fixada em
// `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, então sair dela é um diff visível.
test.describe('Drift & Incidents — Tela 4 @pendente-472', () => {
  test('loads drift page with all 3 incident cards', async ({ page }) => {
    await page.goto('http://localhost:4000/drift');
    await expect(page.locator('h1')).toContainText('Drift');
    await expect(page.locator('text=Bloqueios PEP')).toBeVisible();
    await expect(page.locator('text=Alertas de orçamento')).toBeVisible();
    await expect(page.locator('text=Alertas de regressão')).toBeVisible();
  });
});
