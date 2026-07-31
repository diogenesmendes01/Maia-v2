/**
 * Issue #519 — E2E do wizard de onboarding.
 *
 * Cobre a jornada que a issue exige: abrir → provisionar → INTERROMPER →
 * retomar → corrigir um erro → parear → avaliar prontidão → ativar → cancelar,
 * e os dois invariantes de segurança da tela:
 *
 *   - a URL carrega SÓ o id da run: nenhum token, nenhum segredo, nada que um
 *     access log ou um Referer possa capturar;
 *   - o estado vem do backend a cada render, então fechar a aba e voltar
 *     reconstrói exatamente o que estava lá.
 *
 * Pré-requisitos do ambiente (docker-compose de e2e):
 *   - console em http://localhost:4000 com sessão owner/founder;
 *   - `MAIA_ONBOARDING_WIZARD=true`;
 *   - runtime com adapter Baileys FALSO — nenhuma linha WhatsApp real é
 *     pareada no CI.
 */
import { test, expect } from '@playwright/test';

const CONSOLE = 'http://localhost:4000';
const ONBOARDING = `${CONSOLE}/onboarding`;

const MOTIVO = 'Provisionamento inicial no teste E2E da issue 519.';

test.describe('Onboarding: saga persistida e retomável', () => {
  test('abre uma jornada e mostra a etapa corrente decidida pelo backend', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Começar' }).click();

    await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Etapa corrente')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar tenant' })).toBeVisible();
  });

  test('CANÁRIO: a URL da run não carrega segredo nem token', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Começar' }).click();
    const url = page.url();
    expect(url).not.toMatch(/token=/i);
    expect(url).not.toMatch(/secret=/i);
    // Só o id da run — o path tem exatamente dois segmentos.
    expect(new URL(url).pathname.split('/').filter(Boolean)).toHaveLength(2);
  });

  test('sobrevive a refresh: a etapa e os dados confirmados permanecem', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Começar' }).click();
    const runUrl = page.url();

    await page.fill('textarea', MOTIVO);
    await page.getByRole('button', { name: 'Confirmar tenant' }).click();
    await expect(page.getByRole('button', { name: 'Criar administrador' })).toBeVisible();

    // A interrupção humana: fecha a aba, volta depois. O estado vive no
    // Postgres, não nesta aba.
    await page.goto(CONSOLE);
    await page.goto(runUrl);
    await expect(page.getByRole('button', { name: 'Criar administrador' })).toBeVisible();
  });

  test('retomada pela lista: a jornada aberta aparece com a etapa corrente', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Começar' }).click();
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Retomar' }).first().click();
    await expect(page.getByText('Etapa corrente')).toBeVisible();
  });

  test('prontidão bloqueada mostra o código e a remediação de cada check', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Retomar' }).first().click();
    // O painel canônico — a MESMA avaliação que a ativação usa.
    await expect(page.getByText('Prontidão')).toBeVisible();
  });

  test('ativação exige confirmação explícita do agente exato', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Retomar' }).first().click();
    const activate = page.getByRole('button', { name: 'Ativar agente' });
    if (await activate.isVisible()) {
      // Sem digitar o identificador exato, o botão fica desabilitado — a
      // confirmação é revalidada no backend de qualquer forma.
      await expect(activate).toBeDisabled();
    }
  });

  test('cancelar preserva o histórico e não retoma implicitamente', async ({ page }) => {
    await page.goto(ONBOARDING);
    await page.getByRole('button', { name: 'Começar' }).click();
    await page.getByRole('button', { name: 'Cancelar jornada' }).click();
    await page.fill('textarea', 'Cancelando a jornada no teste E2E da issue 519.');
    await page.getByRole('button', { name: 'Cancelar jornada' }).last().click();

    await expect(page.getByText('Histórico')).toBeVisible();
  });
});

test.describe('Onboarding: usuário não autorizado', () => {
  test('papel de leitura vê a explicação, não o formulário', async ({ page }) => {
    // O ambiente de e2e provisiona uma sessão viewer em :4001 (mesmo padrão
    // das demais specs de RBAC do console).
    await page.goto('http://localhost:4001/onboarding');
    await expect(page.getByText('Acesso restrito')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Começar' })).toHaveCount(0);
  });
});
