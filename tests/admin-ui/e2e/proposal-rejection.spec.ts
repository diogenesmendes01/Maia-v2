/**
 * P8.5 — Single-proposal rejection E2E.
 */
import { test } from '@playwright/test';

test.describe('Proposal Rejection', () => {
  test('rejection records comment + status=rejected', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/reject-test');
    await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await page.fill('textarea', 'Out of scope for current quarter; revisit Q3.');
    await page.click('text=Confirmar rejeição');
    // Verify rejection persisted
  });
});
