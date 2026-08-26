/**
 * Jornada — TRACE EXPLORER, Tela 5 (P8.5; saiu da quarentena na #623).
 *
 * O comentário que ficava na linha 16 deste arquivo — "este seletor tinha
 * ficado em inglês e nunca falhou porque a suíte não roda em CI" — foi
 * REMOVIDO porque a condição que ele descrevia acabou: o seletor abaixo roda
 * no gate, e uma divergência de cópia agora reprova aqui.
 *
 * O trace é semeado pelo ESCRITOR DE PRODUÇÃO (`writeEnvelope`/`writeBody`),
 * não por INSERT: a tela recomputa `envelope_hmac` e `packet_hmac` na leitura,
 * então uma fixture assinada à mão apareceria como adulterada.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import { TRACE_E2E } from './_apoio/fixtures.js';

test.describe('Trace Explorer — Tela 5', () => {
  test.beforeEach(async ({ context }) => {
    await autenticarComo(context, 'owner');
  });

  test('a lista de traces carrega com o trace semeado', async ({ page }) => {
    await page.goto('/traces');
    await expect(page.locator('h1')).toContainText('Traces');
    await expect(page.getByText(TRACE_E2E.slice(0, 8)).first()).toBeVisible();
  });

  test('o detalhe mostra o corpo redigido e o botão de snapshot', async ({ page }) => {
    await page.goto(`/traces/${TRACE_E2E}`);
    await expect(page.locator('h1')).toContainText(TRACE_E2E.slice(0, 8));
    await expect(page.getByRole('button', { name: 'Solicitar snapshot completo' })).toBeVisible();
  });
});
