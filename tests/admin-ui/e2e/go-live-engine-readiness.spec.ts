/**
 * Jornada — MOTOR REMOTO INDISPONÍVEL bloqueia o "colocar no ar" (SC03-AC04,
 * correção pós-QA239/240).
 *
 * ─── O achado que esta jornada mede no browser ──────────────────────────────
 *
 * O checklist de go-live decidia "tudo pronto" por booleanos LOCAIS (perfil
 * ativo, canal, política) e sumia da tela. O QA independente apontou o falso
 * positivo: um agente que PEDE o motor remoto e está com o motor indisponível
 * aparecia como pronto — o card desaparecia exatamente no estado em que o
 * operador precisa vê-lo.
 *
 * Agora o veredito vem da projeção canônica `AgentReadiness.engine`, servida
 * pelo backend em `channelPolicies.channelsOverview` (opt-in `includeEngine`).
 * O console NÃO reavalia readiness no React (§8.3.3): ele consulta e apresenta.
 *
 * ─── O estado semeado ───────────────────────────────────────────────────────
 *
 * `scripts/seed-admin-ui-e2e-fixtures.ts` grava uma linha
 * `agent_engine_policies(engine='hermes')` para o agente `primary`, e nenhuma
 * atestação de implantação existe no banco — então o backend responde
 * `requested: true, available: false, unavailable_reason: 'evidence_absent'`.
 * É o veredito que tem de chegar à tela, com o motivo fechado, sem o card
 * sumir.
 *
 * A sessão é sintética (ver `_apoio/sessao.ts`): o handshake com o IdP é a
 * única parte que a jornada pula — middleware, `auth()`, `createTRPCContext`,
 * o papel e a própria procedure são os de produção.
 */
import { test, expect } from '@playwright/test';
import { AGENTE_E2E, autenticarComo } from './_apoio/sessao.js';

test.describe('Checklist de go-live — motor remoto indisponível (SC03-AC04)', () => {
  test.beforeEach(async ({ context }) => {
    await autenticarComo(context, 'owner');
  });

  test('o card NÃO some e mostra o motivo fechado do backend', async ({ page }) => {
    await page.goto(`/agents/${AGENTE_E2E}`);

    // O card continua na tela: é exatamente ele que sumia quando o motor
    // remoto estava pedido e indisponível.
    await expect(page.getByText('Colocar no ar')).toBeVisible();

    // O item do motor, alimentado SÓ pela projeção do backend, entra
    // bloqueando o "pronto".
    await expect(page.getByText('Motor remoto (Hermes)')).toBeVisible();
    await expect(
      page.getByText('Sem atestação de implantação aprovada para este ambiente'),
    ).toBeVisible();
  });
});