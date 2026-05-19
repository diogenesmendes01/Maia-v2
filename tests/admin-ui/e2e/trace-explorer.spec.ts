/**
 * P8.5 — Tela 5 (Audit & Trace Explorer) E2E tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Trace Explorer — Tela 5', () => {
  test('loads traces page', async ({ page }) => {
    await page.goto('http://localhost:4000/traces');
    await expect(page.locator('h1')).toContainText('Audit & Trace Explorer');
  });

  test('trace detail shows redacted packet + snapshot grant button', async ({ page }) => {
    await page.goto('http://localhost:4000/traces/test-trace-id');
    await expect(page.locator('text=Request full snapshot')).toBeVisible();
  });
});
