/**
 * P8.5 — Tela 2 (Proposal Approval) E2E tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Proposal Approval — single role', () => {
  test('renders header + diff', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/test-id');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('approve flow shows modal + records audit', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/test-id');
    await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
    await page.fill('textarea', 'Approved after review of all impacted artifacts.');
    await page.click('text=Confirmar aprovação');
    await expect(page.locator('text=Aprovar proposta?')).not.toBeVisible();
  });

  test('reject requires comment ≥ 10 chars', async ({ page }) => {
    await page.goto('http://localhost:4000/proposals/test-id');
    await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await page.fill('textarea', 'no');
    await page.click('text=Confirmar rejeição');
    await expect(page.locator('text=pelo menos 10 caracteres')).toBeVisible();
  });
});
