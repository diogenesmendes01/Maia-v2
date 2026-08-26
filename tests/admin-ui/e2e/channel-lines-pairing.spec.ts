/**
 * Jornada — PAREAMENTO DE LINHA WHATSAPP (issue #518).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ESTA JORNADA CONTINUA EM QUARENTENA (#623)
 * ─────────────────────────────────────────────────────────────────────────
 * As outras nove jornadas saíram: a causa delas era sessão e fixture, e as
 * duas o job resolve. Esta tem outra causa, e ela não é do console.
 *
 * MEDIDO no código, não suposto: `trpc/routers/channelLines.ts` NÃO gera QR
 * nem código. `startPairing` grava um COMANDO em `channel_line_state`
 * (`requestCommandWithAudit`) e devolve; quem conecta no WhatsApp, produz o
 * QR e cifra o material com `MAIA_STAGING_KEYRING` é o worker
 * `channel_pairing` do RUNTIME. O console só decifra o envelope que o runtime
 * gravou (`openPairingMaterial`, `src/setup/pairing-material.ts`), e
 * `getPairingStatus` responde `pairing_available: false` quando o keyring não
 * está configurado.
 *
 * O job `build + e2e do console (admin-ui)` sobe UM processo: o artefato
 * standalone do console. Não há runtime, e portanto não há QR, não há código
 * de 8 dígitos e não há transição para `pareando` — quatro dos seis casos
 * deste arquivo esperam exatamente isso. Fazê-los passar exigiria (a) subir o
 * runtime no job com um adapter Baileys FALSO (a própria #518 proíbe linha
 * real no CI) e (b) compartilhar `MAIA_STAGING_KEYRING` entre os dois
 * processos. Isso é um job novo, não um ajuste de spec — e inventar um mock
 * do runtime dentro do teste mediria o mock.
 *
 * CRITÉRIO OBJETIVO PARA SAIR DAQUI (o que precisa existir, não "quando der"):
 *   1. o CI subir, no mesmo job, um runtime Maia com adapter de canal FALSO,
 *      compartilhando `DATABASE_URL`, `REDIS_URL` e `MAIA_STAGING_KEYRING`
 *      com o console; e
 *   2. `channelLines.getPairingStatus` responder `pairing_available: true`
 *      nesse ambiente.
 * Com esses dois fatos, tirar a tag daqui é um diff de uma linha.
 *
 * Rastreamento: os dois fatos acima são o critério; enquanto não existir
 * issue própria para subir o runtime no job, este cabeçalho e a lista fixa de
 * `tests/unit/ci/admin-ui-e2e-gate.spec.ts` são o registro — a quarentena não
 * pode crescer sem passar por eles.
 *
 * Os dois casos que NÃO dependem do runtime (a linha declarada aparecer na
 * listagem e o viewer não enxergar a tela) ficam junto de propósito: partir o
 * arquivo deixaria uma "jornada de pareamento" que não pareia, e é essa
 * meia-verdade que a #623 está desfazendo no resto da suíte.
 */
import { test, expect } from '@playwright/test';

const CONSOLE = 'http://localhost:4000';
const CHANNELS = `${CONSOLE}/setup/channels`;

test.describe('Setup → Canais: linhas WhatsApp @pendente-runtime', () => {
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
