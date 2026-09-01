/**
 * Jornada — PAREAMENTO DE LINHA WHATSAPP (issue #518).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE ARQUIVO CONTINUA EM QUARENTENA — caso a caso
 * ─────────────────────────────────────────────────────────────────────────
 * A #623 tirou nove jornadas da quarentena; a décima ficou inteira, com um
 * argumento de denominador comum ("quatro dos seis casos precisam do runtime,
 * logo os seis ficam fora"). Os dois que NÃO precisavam saíram daqui para
 * `channel-lines.spec.ts` e hoje são gate bloqueante: a listagem da linha
 * declarada e a recusa ao papel `viewer`. O que sobrou tem motivo próprio,
 * um por caso — e o título é o do `test()`, conferido por
 * `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, para que "o arquivo depende do
 * runtime" não volte a valer como motivo coletivo:
 *
 *   FORA DO GATE: pareamento por QR: modal autenticado, QR inline, countdown e cancelamento
 *     o QR é PRODUZIDO pelo worker `channel_pairing` do runtime; sem ele não
 *     existe material nenhum para a tela mostrar.
 *   FORA DO GATE: pareamento por código mostra os 8 dígitos formatados
 *     idem, para o código de 8 dígitos — quem o pede ao WhatsApp é a
 *     PairingSession, não o console.
 *   FORA DO GATE: CANÁRIO: nenhum bootstrap token em URL, request ou HTML do console
 *     precisa chegar até o QR VISÍVEL para ter o que canariar; sem material,
 *     "não há token em lugar nenhum" passaria por vacuidade — e um canário
 *     vacuamente verde é pior que canário nenhum.
 *   FORA DO GATE: acessibilidade: o modal é um dialog e o estado é uma live region
 *     este NÃO depende do runtime, e sim do KEYRING: o CTA "Parear" é
 *     `disabled={!pairingAvailable}` e `pairing_available` é
 *     `isPairingMaterialConfigured()`. Ver abaixo por que o keyring sozinho
 *     não resolve — e por que ele não deve vir antes do runtime.
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
 * de 8 dígitos e não há transição para `pareando`. Fazê-los passar exigiria
 * (a) subir o runtime no job com um adapter Baileys FALSO (a própria #518
 * proíbe linha real no CI) e (b) compartilhar `MAIA_STAGING_KEYRING` entre os
 * dois processos. Isso é um job novo, não um ajuste de spec — e inventar um
 * mock do runtime dentro do teste mediria o mock.
 *
 * POR QUE NÃO BASTA (E NÃO SE DEVE) SÓ PÔR O KEYRING NO JOB, pelo caso 4:
 *   - com keyring e sem runtime, `pairing_available` vira `true`, o CTA
 *     habilita e os casos 1–3 deixam de falhar por "botão desabilitado" para
 *     falhar por TIMEOUT de 15s esperando um material que ninguém escreve —
 *     mais lento e menos legível, sem medir nada a mais;
 *   - e o caso `sem keyring o console declara o pareamento indisponível e
 *     desabilita o CTA`, em `channel-lines.spec.ts`, ficaria VERMELHO: ele é
 *     justamente a premissa desta quarentena virada asserção;
 *   - o keyring é material de chave. O bloco `env:` do workflow entra na
 *     HISTÓRIA do repositório, e é a história que o gitleaks varre.
 *   Ou seja: o keyring entra JUNTO com o runtime, nunca antes.
 *
 * CRITÉRIO OBJETIVO PARA SAIR DAQUI (o que precisa existir, não "quando der"):
 *   1. o CI subir, no mesmo job, um runtime Maia com adapter de canal FALSO,
 *      compartilhando `DATABASE_URL`, `REDIS_URL` e `MAIA_STAGING_KEYRING`
 *      com o console; e
 *   2. `channelLines.getPairingStatus` responder `pairing_available: true`
 *      nesse ambiente.
 * Com esses dois fatos, tirar a tag daqui é um diff de uma linha — e o caso da
 * degradação honesta em `channel-lines.spec.ts` fica vermelho no mesmo commit,
 * avisando que a premissa mudou.
 *
 * Rastreamento: issue própria — "subir um runtime Maia com adapter de canal
 * falso no job do console" —, mais a lista fixa de
 * `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, que impede a quarentena de
 * crescer em silêncio.
 *
 * ESTADO DOS CASOS ABAIXO: eles usam `baseURL` (relativo) e a sessão
 * sintética das outras jornadas, como todo o resto da suíte — não porque
 * rodem, mas para que, quando rodarem, a primeira falha seja a AUSÊNCIA DO
 * RUNTIME e não um `http://localhost:4000` fixo ou a tela de login. Medido
 * com o console no ar e sem runtime: os quatro reprovam no CTA desabilitado,
 * que é a causa certa.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo, AGENTE_E2E } from './_apoio/sessao.js';
import { LINHA_DECLARADA_E2E } from './_apoio/fixtures.js';

const CANAIS = '/setup/channels';

/** A tabela só existe depois que um agente está escolhido — ver `channel-lines.spec.ts`. */
async function abrirPareamento(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(CANAIS);
  await page.getByLabel('Agente').selectOption(AGENTE_E2E);
  await page
    .getByRole('row')
    .filter({ hasText: LINHA_DECLARADA_E2E.externalId })
    .getByRole('button', { name: 'Parear' })
    .click();
}

test.describe('Setup → Canais: pareamento de linha WhatsApp @pendente-runtime', () => {
  test.beforeEach(async ({ context }) => {
    await autenticarComo(context, 'owner');
  });

  test('pareamento por QR: modal autenticado, QR inline, countdown e cancelamento', async ({
    page,
  }) => {
    await abrirPareamento(page);

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
    await abrirPareamento(page);
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

    await abrirPareamento(page);
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

  test('acessibilidade: o modal é um dialog e o estado é uma live region', async ({ page }) => {
    await abrirPareamento(page);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('line-pairing-state')).toHaveAttribute('aria-live', 'polite');
    // Escape fecha (contrato do componente Modal).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
