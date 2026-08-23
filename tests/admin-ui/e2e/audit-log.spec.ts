/**
 * P8.5 — Audit log E2E tests.
 *
 * Verifies that:
 *   - Every approve/reject/bulk-reject/rollback/snapshot-grant action writes
 *     exactly one admin_audit_log row.
 *   - No mutation can edit/delete past audit rows.
 */
import { test } from '@playwright/test';

// `@pendente-472`: fora do gate de CI (projeto `jornadas-pendentes` do
// playwright.config.ts). Esta spec exige sessão autenticada e fixtures que
// `scripts/seed-proposals-fixtures.ts` ainda não cria — ligá-la é a #472. A
// lista de arquivos em quarentena é fixada em
// `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, então sair dela é um diff visível.
test.describe('Audit Log @pendente-472', () => {
  test('approval writes single audit entry', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/audit-test');
    await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
    await page.fill('textarea', 'Audit trail integration test approval.');
    await page.click('text=Confirmar aprovação');
    // Verify via API: audit count incremented by 1
  });

  test('bulk reject writes N audit entries (one per id)', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    // Select 3 low-risk proposals; bulk reject
    // Verify: audit count incremented by 3
  });
});
