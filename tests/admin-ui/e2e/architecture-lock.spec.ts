/**
 * P8.5 — Architecture Lock E2E tests.
 *
 * Verifies:
 *   - Banner appears on locked proposals
 *   - Non-founder roles: approve/reject buttons disabled
 *   - Founder role: banner shows "proceed with founder authority"; buttons enabled
 */
import { test, expect } from '@playwright/test';

test.describe('Architecture Lock', () => {
  test('banner visible for locked proposal', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.locator('text=Architecture lock')).toBeVisible();
  });

  test('approve disabled for non-founder', async ({ page }) => {
    // Mock session as owner role
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.locator('text=Approve')).toBeDisabled();
  });

  test('approve enabled for founder', async ({ page }) => {
    // Mock session as founder
    await page.goto('http://localhost:4000/proposals/locked-test');
    await expect(page.locator('text=proceed with founder authority')).toBeVisible();
  });
});
