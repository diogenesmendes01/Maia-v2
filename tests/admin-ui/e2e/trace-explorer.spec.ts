/**
 * P8.5 — Tela 5 (Audit & Trace Explorer) E2E tests.
 */
import { test, expect } from '@playwright/test';

test.describe('Trace Explorer — Tela 5', () => {
  test('loads traces page', async ({ page }) => {
    await page.goto('http://localhost:4000/traces');
    await expect(page.locator('h1')).toContainText('Traces');
  });

  test('trace detail shows redacted packet + snapshot grant button', async ({ page }) => {
    await page.goto('http://localhost:4000/traces/test-trace-id');
    // Issue #481 item 4 — a cópia da tela é pt-BR desde a tradução do
    // console; este seletor tinha ficado em inglês ("Request full snapshot")
    // e nunca falhou porque a suíte Playwright ainda não roda em CI (#472).
    // Fonte: src/admin-ui/app/traces/[traceId]/page.tsx.
    await expect(page.locator('text=Solicitar snapshot completo')).toBeVisible();
  });
});
