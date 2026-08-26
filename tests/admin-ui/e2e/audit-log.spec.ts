/**
 * Jornada — TRILHA DE AUDITORIA (P8.5; saiu da quarentena na #623).
 *
 * Antes da #623 as duas jornadas deste arquivo NÃO tinham asserção: a
 * primeira terminava num comentário "Verify via API: audit count incremented
 * by 1" e a segunda era só um `goto`. A segunda passava — verde por ausência
 * de asserção, contra a tela de login. É o caso exato que a #623 existe para
 * fechar.
 *
 * As contagens abaixo são ABSOLUTAS, nunca deltas: `restaurarPropostas` apaga
 * a trilha das fixtures antes de cada caso, então "exatamente 1 linha" e
 * "exatamente 3 linhas" valem também na SEGUNDA tentativa do Playwright
 * (`retries: 2` no CI). Um delta (antes × depois) ficaria verde na retentativa
 * herdando a mutação da primeira.
 */
import { test, expect } from '@playwright/test';
import { autenticarComo } from './_apoio/sessao.js';
import {
  PROPOSTAS_DO_LOTE,
  PROPOSTAS_E2E,
  auditoriaDaProposta,
  restaurarPropostas,
  statusDaProposta,
} from './_apoio/fixtures.js';

test.describe('Trilha de auditoria', () => {
  test('aprovar grava EXATAMENTE uma linha de auditoria', async ({ page, context }) => {
    await restaurarPropostas([PROPOSTAS_E2E.auditoria]);
    await autenticarComo(context, 'owner');

    await page.goto(`/proposals/${PROPOSTAS_E2E.auditoria}`);
    await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
    await page.locator('textarea').fill('Aprovação da jornada E2E da trilha de auditoria.');
    await page.getByRole('button', { name: 'Confirmar aprovação' }).click();
    // O modal fecha quando a mutação resolve — é o sinal de que o servidor
    // respondeu, e não de que o clique aconteceu.
    await expect(page.getByText('Aprovar proposta?')).toBeHidden();

    const trilha = await auditoriaDaProposta(PROPOSTAS_E2E.auditoria);
    expect(trilha.map((l) => l.action)).toEqual(['proposal_approve']);
    expect(trilha[0]?.actor_role).toBe('owner');
    expect(trilha[0]?.actor_id).toBe('e2e-user-owner');
  });

  test('rejeição em massa grava UMA linha por proposta (três ids, três linhas)', async ({
    page,
    context,
  }) => {
    await restaurarPropostas(PROPOSTAS_DO_LOTE);
    await autenticarComo(context, 'owner');

    await page.goto('/inbox');
    // O checkbox de cada linha é rotulado com o descritor da proposta
    // (`aria-label="Selecionar <descritor>"`, em `inbox-table.tsx`).
    for (const rotulo of ['lote 1', 'lote 2', 'lote 3']) {
      await page.getByRole('checkbox', { name: `Selecionar Jornada E2E — ${rotulo}` }).check();
    }
    await page.getByRole('button', { name: 'Rejeitar em massa' }).click();
    await page.locator('textarea').fill('Rejeição em massa da jornada E2E da trilha.');
    await page.getByRole('button', { name: 'Confirmar rejeição' }).click();
    await expect(page.getByText('Rejeitar 3 proposta(s) em massa?')).toBeHidden();

    for (const id of PROPOSTAS_DO_LOTE) {
      const trilha = await auditoriaDaProposta(id);
      expect(trilha.map((l) => l.action), `trilha da proposta ${id}`).toEqual([
        'proposal_reject',
      ]);
      expect(await statusDaProposta(id), `status da proposta ${id}`).toBe('rejected');
    }
  });
});
