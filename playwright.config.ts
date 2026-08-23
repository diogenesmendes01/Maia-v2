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
 *   middleware, route handlers, render de servidor e hidratação do cliente.
 *   É a rede de segurança que as issues #604 (Next 16) e #605 (Recharts 3)
 *   exigem como pré-requisito.
 *
 * `jornadas-pendentes` — as specs de P8.5/#518 marcadas `@pendente-472`.
 *   Elas navegam para telas atrás de sessão (`middleware.ts` redireciona TUDO
 *   para /auth/signin) e dependem de fixtures que `scripts/seed-proposals-
 *   fixtures.ts` não cria (`test-id`, `locked-test`, `hard-limit-test`,
 *   `audit-test`, `reject-test`, `test-trace-id`). Fazê-las passar é a #472
 *   inteira, não este pré-requisito. Ficam FORA do gate de propósito e de
 *   forma auditável: `tests/unit/ci/admin-ui-e2e-gate.spec.ts` fixa a lista
 *   exata de arquivos em quarentena, então entrar ou sair dela é um diff
 *   visível — não um `skip` condicional que ninguém lê.
 *
 * Spec NOVA entra em `smoke` por construção (a quarentena é opt-in por tag).
 */
const PENDENTE_472 = /@pendente-472/;

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
      grepInvert: PENDENTE_472,
      use: chromium,
    },
    {
      name: 'jornadas-pendentes',
      grep: PENDENTE_472,
      use: chromium,
    },
  ],
});
