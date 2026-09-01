/**
 * Jornada — LINHAS DE CANAL: listagem, papel e degradação honesta (#518/#623).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este arquivo existe separado de `channel-lines-pairing.spec.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * A #623 deixou a décima jornada inteira em quarentena com um argumento de
 * DENOMINADOR COMUM: quatro dos seis casos dependem do worker `channel_pairing`
 * do runtime, logo os seis ficam fora. Só que os outros dois não dependem de
 * runtime nenhum — dependem de uma FIXTURE e de uma SESSÃO, que é exatamente o
 * que as outras nove jornadas ganharam quando saíram da quarentena.
 *
 * A contabilidade da quarentena é por ARQUIVO — a lista `QUARENTENA` de
 * `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, a contagem que sustenta
 * `TEST_ADMIN_UI_MIN_TESTS` e o `grep -l` do passo de legibilidade do job. Com
 * os seis casos num arquivo só, "medir os dois que dá para medir" é
 * irrepresentável. Daí a separação: este arquivo cobre o que o CONSOLE faz
 * sozinho, e `channel-lines-pairing.spec.ts` continua marcado, com os quatro
 * casos que precisam de um segundo processo.
 *
 * O nome também deixou de mentir: uma "jornada de pareamento" que não pareia
 * era a meia-verdade; esta é a jornada de LINHAS — listar, autorizar e dizer o
 * que não dá para fazer.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo, AGENTE_E2E } from './_apoio/sessao.js';
import { LINHA_DECLARADA_E2E } from './_apoio/fixtures.js';

const CANAIS = '/setup/channels';

/**
 * A tela só consulta `channelLines.list` depois que um AGENTE está escolhido
 * (`enabled: allowed && tenantId !== '' && agentId !== ''`); antes disso ela
 * renderiza o `EmptyState` "Escolha um tenant e um agente". Sem esta seleção a
 * jornada mediria o estado vazio e reprovaria com "elemento não encontrado" —
 * a mensagem errada para a causa certa.
 */
async function escolherAgente(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(CANAIS);
  await page.getByLabel('Agente').selectOption(AGENTE_E2E);
}

test.describe('Setup → Canais: linhas do agente', () => {
  test('a linha DECLARADA (inativa) permanece visível com o seu estado', async ({
    page,
    context,
  }) => {
    await autenticarComo(context, 'owner');
    await escolherAgente(page);

    // Antes da #518 a listagem usava `listActive` e um canal WhatsApp sumia da
    // tela logo depois de ser criado — ele nasce inativo, e o operador ficava
    // sem por onde pareá-lo. A asserção é sobre a LINHA semeada, não sobre a
    // primeira linha da tabela: o `default-channel` das migrations também está
    // ali, e ele está `verified_offline`/ativo.
    const linha = page
      .getByRole('row')
      .filter({ hasText: LINHA_DECLARADA_E2E.externalId });
    await expect(linha).toBeVisible();
    await expect(linha.getByText('declarada')).toBeVisible();
    await expect(linha.getByText('não roteia')).toBeVisible();
  });

  /**
   * O CONTROLE do caso de recusa abaixo: o mesmo `goto`, com um papel
   * autorizado, chega à tela. Sem ele, "viewer não vê" ficaria verde também
   * se a rota estivesse quebrada para todo mundo.
   */
  test('owner ENXERGA a tela de linhas (controle do caso de recusa)', async ({
    page,
    context,
  }) => {
    await autenticarComo(context, 'owner');
    await page.goto(CANAIS);
    await expect(page.getByRole('heading', { name: 'Canais' })).toBeVisible();
    await expect(page.getByText('Acesso restrito')).toBeHidden();
  });

  test('viewer não enxerga a tela de linhas', async ({ page, context }) => {
    // O gate de papel da tela (`allowed = founder|owner`). O `?as=viewer` que
    // esta asserção usava antes não existia em lugar nenhum do console — era
    // resíduo de um harness de compose que a suíte nunca teve; a sessão real
    // é a mesma das outras nove jornadas.
    await autenticarComo(context, 'viewer');
    await page.goto(CANAIS);
    await expect(page.getByText('Acesso restrito')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novo canal' })).toBeHidden();
  });

  /**
   * A PREMISSA DA QUARENTENA, como asserção.
   *
   * `channelLines.list` devolve `pairing_available: isPairingMaterialConfigured()`
   * (`src/setup/pairing-material.ts`), e este job não configura
   * `MAIA_STAGING_KEYRING` — o material de pareamento só trafega cifrado e
   * quem o produz é o worker `channel_pairing` do runtime, que o job não sobe.
   * A tela então degrada de forma honesta: explica o que falta e DESABILITA o
   * CTA, em vez de oferecer um botão que só devolve erro.
   *
   * Manter isto verde é o que impede a quarentena de virar folclore: no dia em
   * que alguém subir o runtime e o keyring neste job — o critério de saída
   * escrito no cabeçalho de `channel-lines-pairing.spec.ts` —, este caso fica
   * VERMELHO e obriga a revisitar o que continua marcado. Um comentário não
   * faria isso.
   */
  test('sem keyring o console declara o pareamento indisponível e desabilita o CTA', async ({
    page,
    context,
  }) => {
    await autenticarComo(context, 'owner');
    await escolherAgente(page);

    await expect(page.getByText('Pareamento pelo console indisponível')).toBeVisible();
    const linha = page
      .getByRole('row')
      .filter({ hasText: LINHA_DECLARADA_E2E.externalId });
    await expect(linha.getByRole('button', { name: 'Parear' })).toBeDisabled();
  });
});
