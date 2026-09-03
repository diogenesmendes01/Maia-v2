/**
 * Jornada — LINHAS DE CANAL: listagem, papel e degradação honesta (#518/#623).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este arquivo existe separado de `channel-lines-pairing.spec.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * A #623 deixou a décima jornada inteira em quarentena com um argumento de
 * DENOMINADOR COMUM: quatro dos seis casos dependem do worker `channel_pairing`
 * do runtime, logo os seis ficam fora. Só que os outros dois não dependem de
 * runtime nenhum — dependem de uma FIXTURE e de uma SESSÃO. A contabilidade da
 * quarentena era por ARQUIVO, então "medir os dois que dá para medir" só era
 * representável separando os arquivos. Daí esta divisão.
 *
 * A quarentena hoje está VAZIA: o job passou a subir também um runtime com
 * adapter de canal falso, e `channel-lines-pairing.spec.ts` é gate bloqueante
 * como este. A separação PERMANECE porque ela deixou de ser sobre quarentena e
 * passou a ser sobre assunto: aqui é a jornada de LINHAS — listar, autorizar e
 * dizer o que não dá para fazer —, lá é a jornada de PAREAMENTO, que atravessa
 * dois processos. Juntar os dois arquivos de volta faria um deles depender da
 * infra do outro sem que o nome dissesse.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo, AGENTE_E2E } from './_apoio/sessao.js';
import {
  LINHA_DECLARADA_E2E,
  LINHA_MATERIAL_ILEGIVEL_E2E,
  armarMaterialIlegivel,
  bytesDeMaterialDaLinha,
} from './_apoio/fixtures.js';

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
   * DEGRADAR FECHADO diante de material que não abre.
   *
   * ── Por que este caso foi REESCRITO, e não apagado ────────────────────
   * Até a #623 fechar a quarentena, este caso afirmava outra coisa: "sem
   * keyring o console declara o pareamento indisponível e DESABILITA o CTA".
   * Ele foi escrito como ALARME — a premissa da quarentena virada asserção —,
   * para ficar vermelho no dia em que o job passasse a configurar
   * `MAIA_STAGING_KEYRING`. Esse dia é este commit: o job agora gera um
   * keyring efêmero e o compartilha entre o console e o runtime, então
   * `pairing_available` é `true` e aquele caso seria vermelho por construção.
   *
   * A PROPRIEDADE que ele guardava continua valendo e continua precisando de
   * cobertura: falta material ⇒ a tela degrada FECHADO, nunca mostra conteúdo
   * parcial nem um artefato inventado. O que mudou foi só onde a falta pode
   * ser produzida com um único console no ar. Antes era a chave AUSENTE; agora
   * é o envelope que a chave presente NÃO ABRE — o cenário real de uma chave
   * rotacionada e removida com rows ainda referenciando-a
   * (`staging_key_unavailable`, `src/gateway/staging-crypto.ts`). O caminho
   * exercitado é o mesmo `catch` de `channelLines.getPairingStatus`, que
   * devolve `material: null` "jamais conteúdo parcial".
   *
   * ── Anti-vacuidade ───────────────────────────────────────────────────
   * "A tela não mostra QR" também seria verde se a semeadura tivesse falhado e
   * não houvesse material nenhum. Por isso `armarMaterialIlegivel` devolve
   * quantos BYTES ficaram na tabela, e o caso afirma que eles existem: o
   * console TINHA material e RECUSOU. E a linha está em `pareando` — a tela
   * chegou ao ramo que desenha material e escolheu não desenhar nenhum.
   *
   * ── O controle ───────────────────────────────────────────────────────
   * O controle deste caso é `channel-lines-pairing.spec.ts`, no mesmo projeto
   * bloqueante: lá o envelope é selado pelo runtime com a chave que o console
   * tem, e o QR APARECE. Sem ele, "nunca aparece QR" passaria também com a
   * renderização quebrada para todo mundo.
   */
  test('material de pareamento que não abre: a tela degrada FECHADO', async ({
    page,
    context,
  }) => {
    const bytes = await armarMaterialIlegivel(LINHA_MATERIAL_ILEGIVEL_E2E.channelId);
    expect(
      bytes,
      'a fixture não deixou material na tabela — o caso mediria a ausência, ' +
        'não a recusa',
    ).toBeGreaterThan(0);

    await autenticarComo(context, 'owner');
    await escolherAgente(page);

    const linha = page
      .getByRole('row')
      .filter({ hasText: LINHA_MATERIAL_ILEGIVEL_E2E.externalId });
    await expect(linha).toBeVisible();
    await linha.getByRole('button', { name: 'Acompanhar pareamento' }).click();

    // A tela chegou ao ramo de material: estado `pareando`, modal aberto.
    await expect(page.getByTestId('line-pairing-state')).toContainText('pareando');
    // E não desenhou nada: nem QR, nem código, nem um placeholder com bytes
    // crus. O que aparece é a espera honesta.
    await expect(page.getByAltText('QR Code de pareamento')).toBeHidden();
    await expect(page.getByTestId('pairing-code')).toBeHidden();
    await expect(page.getByText(/Preparando o QR/)).toBeVisible();

    // E o material continua lá, ilegível: a recusa é do console, não uma
    // limpeza silenciosa da fixture pelo caminho.
    expect(await bytesDeMaterialDaLinha(LINHA_MATERIAL_ILEGIVEL_E2E.channelId)).toBe(bytes);
  });
});
