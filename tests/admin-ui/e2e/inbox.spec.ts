/**
 * P8.5 — Tela 1 (Proposal Inbox) E2E tests.
 *
 * Skeleton placeholders for Playwright. Full E2E run requires the admin-ui
 * dev server (`npm run admin:dev`) + seed fixtures (scripts/seed-proposals-fixtures.ts).
 *
 * To run: `npx playwright install` then `npm run test:admin-ui:e2e`.
 */
import { test, expect } from '@playwright/test';

test.describe('Inbox — Tela 1', () => {
  test('loads page and shows header', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    await expect(page.locator('h1')).toContainText('Aprovações');
  });

  test('shows badge counters', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    await expect(page.locator('text=pendente')).toBeVisible();
  });

  test('filter by type updates table', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    await page.click('text=Regra de política');
    await expect(page.locator('table tbody tr')).toBeVisible();
  });

  test('clicking proposal navigates to detail', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    const firstLink = page.locator('table tbody tr a').first();
    await firstLink.click();
    await expect(page).toHaveURL(/\/proposals\/[a-f0-9-]+/);
  });

  test('bulk reject button disabled when nothing selected', async ({ page }) => {
    await page.goto('http://localhost:4000/inbox');
    await expect(page.locator('text=Rejeitar em massa')).not.toBeVisible();
  });
});
