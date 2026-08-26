/**
 * Smoke de BOOT do console construído — o gate de E2E que o CI executa.
 *
 * Pré-requisito das issues #604 (Next 15.5 → 16) e #605 (Recharts 2 → 3):
 * antes desta spec, NADA no CI executava o console. `admin:typecheck` prova
 * tipos, e `tests/admin-ui/unit/` prova routers tRPC em processo — nenhum dos
 * dois carrega o servidor Next, o bundle de middleware (runtime Edge), os
 * route handlers ou o bundle de cliente. Um `next build` que produz um
 * artefato quebrado passava por todos os checks.
 *
 * O que esta spec mede, e por que cada asserção existe:
 *
 *   1. Middleware (bundle Edge, o primeiro a quebrar num major do Next):
 *      rota protegida redireciona para /auth/signin preservando `callbackUrl`.
 *   2. Route handler do NextAuth (`app/api/auth/[...nextauth]/route.ts`):
 *      /api/auth/providers responde JSON. É o handler que fazia o `next build`
 *      morrer em "Failed to collect page data" quando o env do build regredia.
 *   3. Render de servidor + HIDRATAÇÃO do cliente: /auth/signin é
 *      `'use client'` e começa em "Carregando opções de entrada…"; só sai
 *      desse estado se o bundle de cliente carregar, o React montar e o
 *      `getProviders()` do NextAuth completar. Uma quebra de hidratação num
 *      major do React/Next deixa a tela travada no texto de carregamento.
 *   4. Cabeçalhos de segurança de `next.config.mjs` (`headers()`): a API que
 *      os produz é exatamente do tipo que muda entre majors, e perdê-los é
 *      silencioso.
 *   5. Nenhum erro de console e nenhuma resposta 5xx durante a jornada —
 *      é o canário de regressão de runtime do console.
 *
 * SEM sessão e SEM fixtures de propósito: tudo aqui vale contra um console
 * recém-construído apontado para um banco migrado e vazio. As jornadas
 * autenticadas passaram a rodar no MESMO gate na #623 — elas montam a sessão
 * em `tests/admin-ui/e2e/_apoio/sessao.ts` e dependem das fixtures de
 * `scripts/seed-admin-ui-e2e-fixtures.ts`. Esta spec continua não dependendo
 * de nenhuma das duas: é o caso que ainda vale contra banco vazio.
 */
import { test, expect, type ConsoleMessage, type Response } from '@playwright/test';

/** Rota protegida qualquer: o que se afirma é o middleware, não a tela. */
const ROTA_PROTEGIDA = '/inbox';

test.describe('Console construído — boot', () => {
  test('middleware redireciona rota protegida para /auth/signin com callbackUrl', async ({
    page,
  }) => {
    await page.goto(ROTA_PROTEGIDA);
    await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=%2Finbox$/);
  });

  test('route handler do NextAuth responde /api/auth/providers em JSON', async ({
    request,
  }) => {
    const res = await request.get('/api/auth/providers');
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    // O corpo é um objeto de providers. Pode estar VAZIO (é o estado correto
    // de um console sem OIDC e sem magic-link), então a asserção é sobre a
    // FORMA — que o handler executou e serializou —, não sobre o conteúdo.
    expect(typeof (await res.json())).toBe('object');
  });

  test('/auth/signin hidrata: sai do estado de carregamento e renderiza o título', async ({
    page,
  }) => {
    await page.goto('/auth/signin');
    await expect(page.getByRole('heading', { name: 'Entrar no Maia Console' })).toBeVisible();
    // A transição que prova hidratação: o texto de carregamento é o estado
    // INICIAL do componente cliente e só some depois de `getProviders()`
    // resolver no navegador.
    await expect(page.getByText('Carregando opções de entrada…')).toBeHidden({
      timeout: 15_000,
    });
  });

  test('cabeçalhos de segurança de next.config.mjs chegam na resposta', async ({
    request,
  }) => {
    const res = await request.get('/auth/signin');
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('nenhum erro de console e nenhuma resposta 5xx na jornada pública', async ({
    page,
  }) => {
    const erros: string[] = [];
    const servidor: string[] = [];

    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') erros.push(msg.text());
    });
    page.on('pageerror', (err: Error) => erros.push(`pageerror: ${err.message}`));
    page.on('response', (res: Response) => {
      if (res.status() >= 500) servidor.push(`${res.status()} ${res.url()}`);
    });

    await page.goto(ROTA_PROTEGIDA);
    await expect(page.getByRole('heading', { name: 'Entrar no Maia Console' })).toBeVisible();
    await expect(page.getByText('Carregando opções de entrada…')).toBeHidden({
      timeout: 15_000,
    });

    expect(servidor, `respostas 5xx: ${servidor.join(' | ')}`).toHaveLength(0);
    expect(erros, `erros de console: ${erros.join(' | ')}`).toHaveLength(0);
  });
});
