/**
 * Jornada — PAREAMENTO DE LINHA WHATSAPP (issues #518 e #623).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ESTE ARQUIVO SAIU DA QUARENTENA — o que mudou, exatamente
 * ─────────────────────────────────────────────────────────────────────────
 * Ele passou anos fora do gate por um motivo que era verdade: o QR e o código
 * de 8 dígitos NÃO são produzidos pelo console. `channelLines.startPairing`
 * grava um COMANDO em `channel_line_state` (`requestCommandWithAudit`) e
 * devolve; quem conecta, produz o material e o cifra com
 * `MAIA_STAGING_KEYRING` é o worker `channel_pairing` do RUNTIME. O job
 * `build + e2e do console (admin-ui)` subia UM processo — o console — e sem o
 * segundo não havia QR, não havia código e não havia transição para
 * `pareando`.
 *
 * O critério objetivo de saída que o cabeçalho anterior escreveu foi
 * cumprido, e é ele que este arquivo agora exercita:
 *
 *   1. o job sobe, no mesmo passo, um runtime Maia com adapter de canal FALSO
 *      (`tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts`, papel
 *      `scheduler` + grupo de jobs `channel`), compartilhando `DATABASE_URL`,
 *      `REDIS_URL` e `MAIA_STAGING_KEYRING` com o console; e
 *   2. com o keyring nos dois processos, `channelLines.list` responde
 *      `pairing_available: true` e o CTA "Parear" deixa de nascer desabilitado.
 *
 * O adapter falso NÃO é uma chave de configuração — ele é injetado na
 * CONSTRUÇÃO do `LineSessionManager` por um entrypoint que só o teste executa,
 * e `tests/unit/gateway/pairing-adapter-seam.spec.ts` prova que nenhuma
 * variável do contrato o alcança. A razão é de segurança: provar posse é o que
 * AUTORIZA a linha a rotear, e um interruptor de configuração para "posse
 * provada por socket falso" seria fail-open exatamente aí.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE ESTA JORNADA MEDE — e o que ela deliberadamente NÃO mede
 * ─────────────────────────────────────────────────────────────────────────
 * MEDE, ponta a ponta e com código de produção em toda a travessia: console →
 * comando durável no Postgres → worker `channel_pairing` → `startChannelPairing`
 * → PairingSession → material SELADO (AES-256-GCM) → console decifra
 * (`openPairingMaterial`) e desenha. O único trecho substituído é a borda que
 * fala WhatsApp.
 *
 * NÃO MEDE que a Maia conversa com o WhatsApp, e não pode: o adapter falso
 * jamais emite `connection: 'open'`, que é o evento que promoveria o auth
 * state e ATIVARIA o canal. Um adapter que emitisse `open` estaria fabricando
 * prova de posse. Por isso nenhum caso aqui afirma `verificada`, `conectada`
 * ou `roteando` — a jornada vai até o material na tela e o cancelamento, que é
 * exatamente o que o console é dono de fazer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que cada caso RESTAURA a linha antes de rodar
 * ─────────────────────────────────────────────────────────────────────────
 * Os quatro casos dividem a MESMA linha semeada, e três deles a deixam em
 * `pareando` com uma PairingSession VIVA na memória do runtime. Sem restaurar,
 * o segundo caso pediria um start sobre um pairing em curso e receberia
 * `pairing_in_progress` — a jornada mediria a colisão, não o pareamento.
 * `restaurarLinhaParaDeclarada` cancela pelo CAMINHO REAL (o comando
 * `abort_pairing` que o runtime executa), e não por um UPDATE que apagaria a
 * fila e deixaria o socket falso vivo.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo, AGENTE_E2E } from './_apoio/sessao.js';
import { LINHA_DECLARADA_E2E, restaurarLinhaParaDeclarada } from './_apoio/fixtures.js';

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

test.describe('Setup → Canais: pareamento de linha WhatsApp', () => {
  test.beforeEach(async ({ context }) => {
    await restaurarLinhaParaDeclarada(LINHA_DECLARADA_E2E.channelId);
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
    // com credencial (era o `/setup/qr.png?token=…`). Quem o produziu foi o
    // worker `channel_pairing` do runtime, e o console só conseguiu desenhá-lo
    // porque ABRIU o envelope com a mesma chave: este `toBeVisible` é a
    // travessia inteira dos dois processos.
    const qr = page.getByAltText('QR Code de pareamento');
    await expect(qr).toBeVisible({ timeout: 30_000 });
    await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);

    await expect(page.getByTestId('line-pairing-state')).toContainText('pareando');
    // O countdown do material só aparece quando há material com validade — é a
    // asserção que distingue "QR na tela" de "spinner esperando o runtime".
    await expect(page.getByText(/Este QR expira em/)).toBeVisible();

    // Cancelar é o caminho real: o console enfileira `abort_pairing`, a linha
    // vai para `cancelando` e só volta para `declarada` quando o RUNTIME
    // confirmar que a sessão morreu.
    await page.getByRole('button', { name: 'Cancelar pareamento' }).click();
    await expect(page.getByTestId('line-pairing-state')).toContainText('declarada', {
      timeout: 30_000,
    });
  });

  test('pareamento por código mostra os 8 dígitos formatados', async ({ page }) => {
    await abrirPareamento(page);
    await page.getByRole('button', { name: 'Código de 8 dígitos' }).click();
    await page.fill('textarea', 'Parear por código no teste E2E da issue 518.');
    await page.getByRole('button', { name: 'Iniciar pareamento' }).click();

    // Quem pede o código ao WhatsApp é a PairingSession (`requestPairingCode`),
    // não o console: os 8 caracteres chegam aqui pelo mesmo envelope cifrado.
    await expect(page.getByTestId('pairing-code')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, {
      timeout: 30_000,
    });
    // E o método escolhido é respeitado ponta a ponta: nada de QR na tela do
    // fluxo de código (o material é um só por tentativa — o último a chegar
    // sobrescreve, e trocar de artefato no meio seria a corrida que o adapter
    // evita).
    await expect(page.getByAltText('QR Code de pareamento')).toBeHidden();
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
    // ANTI-VACUIDADE do canário: ele precisa chegar até o QR VISÍVEL. Sem
    // material na tela, "não há token em lugar nenhum" passaria por não haver
    // nada — e um canário vacuamente verde é pior que canário nenhum.
    await expect(page.getByAltText('QR Code de pareamento')).toBeVisible({ timeout: 30_000 });

    expect(offending, `URLs com token: ${offending.join(', ')}`).toHaveLength(0);
    expect(page.url()).not.toMatch(/token=/);

    const html = await page.content();
    expect(html).not.toMatch(/setup\/qr\.png\?/);
    expect(html).not.toMatch(/[?&]token=/);
  });

  test('acessibilidade: o modal é um dialog e o estado é uma live region', async ({ page }) => {
    // Este caso não depende do worker: depende do KEYRING. O CTA "Parear" é
    // `disabled={!pairingAvailable}` e `pairing_available` é
    // `isPairingMaterialConfigured()` — sem a chave nos dois processos, o
    // clique de `abrirPareamento` reprovaria em "botão desabilitado" e o modal
    // nunca abriria.
    await abrirPareamento(page);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('line-pairing-state')).toHaveAttribute('aria-live', 'polite');
    // Escape fecha (contrato do componente Modal).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
