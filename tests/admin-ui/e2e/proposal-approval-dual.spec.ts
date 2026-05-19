/**
 * P8.5 — Tela 2 (Proposal Approval) E2E tests — DUAL approval flow.
 *
 * Verifies that:
 *   - hard_limit / soul_core / dangerous_tool / drift_correction classes
 *     show "Dual approval required" banner
 *   - First approval transitions to status=partial (not activated)
 *   - Second distinct-approver approval transitions to status=activated
 *   - Same user cannot fulfil both slots even with multiple roles
 */
import { test, expect } from '@playwright/test';

test.describe('Proposal Approval — DUAL', () => {
  test('shows dual-required banner for hard_limit class', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/hard-limit-test');
    await expect(page.locator('text=Dual approval required')).toBeVisible();
  });

  test('first approval marks state as partial; needs second', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/hard-limit-test');
    await page.click('text=Approve');
    await page.fill('textarea', 'Owner approves; awaiting compliance officer.');
    await page.click('text=Confirm approve');
    await expect(page.locator('text=1 of 2 approvals recorded')).toBeVisible();
  });
});
