/**
 * P8.5 — Single-proposal rejection E2E.
 */
import { test } from '@playwright/test';

// `@pendente-472`: fora do gate de CI (projeto `jornadas-pendentes` do
// playwright.config.ts). Esta spec exige sessão autenticada e fixtures que
// `scripts/seed-proposals-fixtures.ts` ainda não cria — ligá-la é a #472. A
// lista de arquivos em quarentena é fixada em
// `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, então sair dela é um diff visível.
test.describe('Proposal Rejection @pendente-472', () => {
  test('rejection records comment + status=rejected', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/reject-test');
    await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await page.fill('textarea', 'Out of scope for current quarter; revisit Q3.');
    await page.click('text=Confirmar rejeição');
    // Verify rejection persisted
  });
});
