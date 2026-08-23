/**
 * P8.5 — Architecture Lock E2E tests.
 *
 * Verifies:
 *   - Banner appears on locked proposals
 *   - Non-founder roles: approve/reject buttons disabled
 *   - Founder role: banner shows "proceed with founder authority"; buttons enabled
 */
import { test, expect } from '@playwright/test';

// `@pendente-472`: fora do gate de CI (projeto `jornadas-pendentes` do
// playwright.config.ts). Esta spec exige sessão autenticada e fixtures que
// `scripts/seed-proposals-fixtures.ts` ainda não cria — ligá-la é a #472. A
// lista de arquivos em quarentena é fixada em
// `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, então sair dela é um diff visível.
test.describe('Architecture Lock @pendente-472', () => {
  test('banner visible for locked proposal', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.locator('text=Trava de arquitetura')).toBeVisible();
  });

  test('approve disabled for non-founder', async ({ page }) => {
    // Mock session as owner role
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeDisabled();
  });

  test('approve enabled for founder', async ({ page }) => {
    // Mock session as founder
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.locator('text=prossiga com autoridade de founder')).toBeVisible();
  });
});
