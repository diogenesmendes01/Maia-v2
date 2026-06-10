/**
 * P8.5 — Tela 3 (Versions & Rollback) E2E tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Versions & Rollback — Tela 3', () => {
  test('loads versions page', async ({ page }) => {
    await page.goto('http://localhost:4000/versions');
    await expect(page.locator('h1')).toContainText('Versões');
  });

  test('rollback modal validates target is earlier than current', async ({ page }) => {
    await page.goto('http://localhost:4000/versions');
    // Skeleton — wires up once data is seeded.
  });
});
