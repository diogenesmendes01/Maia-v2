import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright — E2E do Admin UI (console Next.js).
 *
 * ## Como isto roda
 *
 * O runner e as specs vivem na RAIZ (`tests/admin-ui/e2e/`), então
 * `@playwright/test` precisa resolver a partir da raiz: ele é `devDependency`
 * do `package.json` da raiz. Antes disto o `npm run test:admin-ui:e2e` morria
 * em `ERR_MODULE_NOT_FOUND: Cannot find package '@playwright/test' imported
 * from playwright.config.ts` — o pacote só existia em
 * `src/admin-ui/node_modules`, que a resolução de módulos a partir da raiz
 * nunca alcança. Um comando documentado que não carrega nem o próprio config
 * é a mesma falha da #550: o manual manda rodar, ninguém roda, e ele apodrece.
 *
 * NÃO existe `webServer` aqui de propósito. Quem sobe o console é
 * `scripts/admin-ui-e2e.sh`, porque o servidor precisa (a) ser o BUILD de
 * produção, não o dev server, (b) receber um bloco de env explícito e (c)
 * falhar o job de forma legível quando não sobe. O `webServer` do Playwright
 * esconde as três coisas atrás de um timeout genérico.
 *
 * ## Os dois projetos
 *
 * `smoke` — o que roda no CI e é BLOQUEANTE. Exercita o console CONSTRUÍDO:
 *   middleware, route handlers, render de servidor e hidratação do cliente,
 *   e — desde a #623 — as JORNADAS autenticadas do operador (inbox, detalhe
 *   de proposta, aprovação simples e dupla, rejeição, trava de arquitetura,
 *   trilha de auditoria, drift, traces, versões e a listagem de linhas de
 *   canal). A sessão é montada em `tests/admin-ui/e2e/_apoio/sessao.ts` e as
 *   fixtures em `scripts/seed-admin-ui-e2e-fixtures.ts`, que
 *   `scripts/admin-ui-e2e.sh` executa antes da suíte.
 *
 * `jornadas-pendentes` — a quarentena, HOJE VAZIA: este projeto casa zero
 *   teste, e é assim que ele deve ficar. A última spec marcada era
 *   `channel-lines-pairing.spec.ts`, e a causa dela não era sessão nem
 *   fixture — o QR e o código de pareamento são produzidos pelo WORKER DO
 *   RUNTIME (`channel_pairing`), e o job subia UM processo só. Desde que
 *   `scripts/admin-ui-e2e.sh` passou a subir também um runtime
 *   (`scheduler` + grupo `channel`) com adapter de canal FALSO, ela é gate
 *   bloqueante como as outras nove.
 *
 *   O projeto NÃO foi apagado junto com a quarentena, e a razão é o mecanismo:
 *   é o `grepInvert` do `smoke` que dá SIGNIFICADO à tag, e é a tag que
 *   `tests/unit/ci/admin-ui-e2e-gate.spec.ts` confere contra uma lista FIXA
 *   (hoje `[]`). Sem os dois, marcar um `describe` deixaria de excluir alguma
 *   coisa — ou, pior, voltaria a excluir sem que nada reprovasse. Um projeto
 *   que casa zero teste é o estado honesto de "não há nada fora do gate", e o
 *   guard o reconfere a cada execução.
 *
 * Spec NOVA entra em `smoke` por construção (a quarentena é opt-in por tag).
 */
const PENDENTE_RUNTIME = /@pendente-runtime/;

/**
 * Escape hatch para ambiente de agente com Chromium pré-instalado num registry
 * que não casa com a versão do Playwright fixada no lockfile (o sandbox deste
 * repo traz `/opt/pw-browsers/chromium-1194`, e o Playwright do lockfile quer
 * outro build). NÃO é um caminho de CI: o workflow instala o browser certo com
 * `npx playwright install chromium`, e o guard abaixo torna impossível usar
 * esta variável lá — um binário divergente do esperado transformaria o gate
 * numa medição de outra coisa.
 *
 * Prefixo neutro de propósito: `MAIA_*`/`FEATURE_*` são rejeitados por
 * `src/config/validate.ts` quando não declarados no contrato, e uma variável
 * no `env:` de um job alcança TODO processo daquele job.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (chromiumExecutable && process.env.CI) {
  throw new Error(
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH está definida com CI=1. ' +
      'No CI o browser é instalado pelo workflow (`npx playwright install ' +
      'chromium`); apontar para um binário arbitrário faria o gate medir ' +
      'outro browser que não o do lockfile. Remova a variável.',
  );
}

const chromium = {
  ...devices['Desktop Chrome'],
  ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
};

export default defineConfig({
  testDir: './tests/admin-ui/e2e',
  fullyParallel: false, // as specs tocam o mesmo banco; serializar por segurança
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // O relatório JSON não é cosmético: `scripts/check-playwright-run.ts` o lê
  // para reprovar uma rodada que executou ZERO teste ou que pulou algum. Um
  // job que imprime "0 tests" sai com código 0 no Playwright — verde por
  // ausência de trabalho é a falha que este arquivo existe para impedir.
  reporter: process.env.CI
    ? [['github'], ['list'], ['json', { outputFile: '.playwright-report/admin-ui.json' }]]
    : [['list'], ['json', { outputFile: '.playwright-report/admin-ui.json' }]],
  use: {
    // `PLAYWRIGHT_*` e não `ADMIN_UI_*`: `ADMIN_UI_` é um dos prefixos
    // reservados de `src/config/metadata.ts` (MAIA_KEY_PREFIXES), e uma chave
    // desconhecida sob ele REPROVA o boot de qualquer processo Maia do mesmo
    // job — o modo de falha que já custou centenas de execuções de CI.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'smoke',
      grepInvert: PENDENTE_RUNTIME,
      use: chromium,
    },
    {
      name: 'jornadas-pendentes',
      grep: PENDENTE_RUNTIME,
      use: chromium,
    },
  ],
});
