/**
 * P8.5 — Tela 3 (Versions & Rollback) E2E tests.
 */
import { test, expect } from '@playwright/test';

// `@pendente-472`: fora do gate de CI (projeto `jornadas-pendentes` do
// playwright.config.ts). Esta spec exige sessão autenticada e fixtures que
// `scripts/seed-proposals-fixtures.ts` ainda não cria — ligá-la é a #472. A
// lista de arquivos em quarentena é fixada em
// `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, então sair dela é um diff visível.
test.describe('Versions & Rollback — Tela 3 @pendente-472', () => {
  test('loads versions page', async ({ page }) => {
    await page.goto('http://localhost:4000/versions');
    await expect(page.locator('h1')).toContainText('Versões');
  });

  test('rollback modal validates target is earlier than current', async ({ page }) => {
    await page.goto('http://localhost:4000/versions');
    // Skeleton — wires up once data is seeded.
  });
});
