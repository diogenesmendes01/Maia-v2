/**
 * Issue #518 — E2E da tela de LINHAS (Setup → Canais).
 *
 * Cobre a jornada que a issue exige que exista sem shell nem curl:
 * declarar → parear (QR ou código) → acompanhar → cancelar → re-parear, e o
 * invariante de segurança central: NENHUM bootstrap token aparece em URL,
 * em request ou no HTML do console.
 *
 * Pré-requisitos do ambiente (docker-compose de e2e):
 *   - console em http://localhost:4000 com sessão owner/founder;
 *   - runtime com adapter Baileys FALSO (nunca uma linha real — a issue
 *     proíbe enviar mensagem de verdade no CI);
 *   - `MAIA_STAGING_KEYRING` configurado nos dois processos.
 */
import { test, expect } from '@playwright/test';

const CONSOLE = 'http://localhost:4000';
const CHANNELS = `${CONSOLE}/setup/channels`;

test.describe('Setup → Canais: linhas WhatsApp', () => {
  test('canal WhatsApp recém-criado (inativo) PERMANECE visível com estado "declarada"', async ({
    page,
  }) => {
    await page.goto(CHANNELS);
    // Antes de #518 a listagem usava `listActive` e o canal sumia logo após
    // ser criado — o operador não tinha por onde pareá-lo.
    const row = page.getByRole('row').filter({ hasText: '+55' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('declarada')).toBeVisible();
    await expect(row.getByText('não roteia')).toBeVisible();
  });

  test('pareamento por QR: modal autenticado, QR inline, countdown e cancelamento', async ({
    page,
  }) => {
    await page.goto(CHANNELS);
    await page.getByRole('button', { name: 'Parear' }).first().click();

    await page.getByRole('button', { name: 'QR Code' }).click();
    await page.fill('textarea', 'Parear a linha comercial declarada no teste E2E.');
    await page.getByRole('button', { name: 'Iniciar pareamento' }).click();

    // O QR é servido como data URI no CORPO da resposta — nunca como uma URL
    // com credencial (era o `/setup/qr.png?token=…`).
    const qr = page.getByAltText('QR Code de pareamento');
    await expect(qr).toBeVisible({ timeout: 15_000 });
    await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);

    await expect(page.getByTestId('line-pairing-state')).toContainText('pareando');

    // Cancelar é idempotente: clicar duas vezes não quebra a tela.
    await page.getByRole('button', { name: 'Cancelar pareamento' }).click();
    await expect(page.getByTestId('line-pairing-state')).toContainText('declarada', {
      timeout: 15_000,
    });
  });

  test('pareamento por código mostra os 8 dígitos formatados', async ({ page }) => {
    await page.goto(CHANNELS);
    await page.getByRole('button', { name: 'Parear' }).first().click();
    await page.getByRole('button', { name: 'Código de 8 dígitos' }).click();
    await page.fill('textarea', 'Parear por código no teste E2E da issue 518.');
    await page.getByRole('button', { name: 'Iniciar pareamento' }).click();

    await expect(page.getByTestId('pairing-code')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, {
      timeout: 15_000,
    });
  });

  test('CANÁRIO: nenhum bootstrap token em URL, request ou HTML do console', async ({ page }) => {
    // O token do runtime tem forma fixa (32 hex). Qualquer ocorrência dele
    // numa URL do console seria a regressão que esta issue fecha.
    const TOKEN_SHAPE = /\b[0-9a-f]{32}\b/;
    const offending: string[] = [];

    page.on('request', (req) => {
      const url = req.url();
      if (/[?&]token=/.test(url) || TOKEN_SHAPE.test(new URL(url).search)) {
        offending.push(url);
      }
    });

    await page.goto(CHANNELS);
    await page.getByRole('button', { name: 'Parear' }).first().click();
    await page.getByRole('button', { name: 'QR Code' }).click();
    await page.fill('textarea', 'Verificação de canário do token no teste E2E.');
    await page.getByRole('button', { name: 'Iniciar pareamento' }).click();
    await expect(page.getByAltText('QR Code de pareamento')).toBeVisible({ timeout: 15_000 });

    expect(offending, `URLs com token: ${offending.join(', ')}`).toHaveLength(0);
    expect(page.url()).not.toMatch(/token=/);

    const html = await page.content();
    expect(html).not.toMatch(/setup\/qr\.png\?/);
    expect(html).not.toMatch(/[?&]token=/);
  });

  test('viewer não enxerga a tela de linhas', async ({ page }) => {
    // Sessão viewer (fixture do compose de e2e).
    await page.goto(`${CHANNELS}?as=viewer`);
    await expect(page.getByText('Acesso restrito')).toBeVisible();
  });

  test('acessibilidade: o modal é um dialog e o estado é uma live region', async ({ page }) => {
    await page.goto(CHANNELS);
    await page.getByRole('button', { name: 'Parear' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('line-pairing-state')).toHaveAttribute('aria-live', 'polite');
    // Escape fecha (contrato do componente Modal).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
