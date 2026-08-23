/**
 * Ativa (ou desativa) o canal da SONDA SINTÉTICA — o caminho de ativação SEGURO
 * e documentado (spec §1.2 / review R2/P1-A/P1-B).
 *
 * Por quê um script, e não o pareamento Baileys: o canal da sonda usa uma linha
 * placeholder (`+999...`) que NENHUMA conta WhatsApp real pode provar posse —
 * então o pareamento (que compara o número reportado pelo Baileys com a linha
 * declarada) SEMPRE falharia. A sonda não precisa de sessão real: o inbound é
 * injetado sinteticamente e TODO o outbound é interceptado pelo sink (que
 * neutraliza qualquer canal `is_synthetic`, independente de flag). O único
 * motivo de o canal precisar de `active=true` é para o exact-match do
 * `resolveChannel` resolver a injeção para o canal de sonda.
 *
 * Segurança:
 *   - a ativação é ATÔMICA e escopada: o UPDATE exige `is_synthetic=true` no
 *     PREDICADO (nunca ativa um canal real, mesmo por engano) e valida o
 *     RETURNING (setChannelActive);
 *   - roda sob o contexto do tenant/agente da sonda e AUDITA a mudança
 *     (`synthetic_probe_channel_activation`), honrando "every side-effect audits";
 *   - NÃO checa o modo de roteamento: `findPrimaryCatchAllChannel` agora IGNORA
 *     canais `is_synthetic` (review P1-A), então um canal de sonda ativo NUNCA
 *     derruba o catch-all real — a ativação é segura em qualquer modo. O worker
 *     ainda só INJETA sob exact_first/strict (guard próprio no runtime).
 *
 * Uso:
 *   npm run probe:activate            # ativa
 *   npm run probe:activate -- --deactivate
 */
// Boot fail-closed do subset `runtime`, EXPLÍCITO (issue #596).
//
// Este processo já validava o contrato inteiro no boot — mas por acidente: ele
// alcançava `@/config/env.ts` de carona, por `@/lib/logger.js` ou
// `@/db/client.ts`. A #596 tirou o singleton daqueles módulos (eles são
// COMPARTILHADOS com o container do console, que não pode pagar o boot do
// `runtime`), e sem esta linha o script passaria a descobrir configuração
// inválida uma variável por vez, em runtime, em vez de reprovar de uma vez no
// início. `tests/unit/config/admin-import-boundary.spec.ts` fixa a lista dos
// processos que precisam dela.
import '@/config/env.js';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { audit } from '@/governance/audit.js';
import { shutdownDb } from '@/db/client.js';
import { syntheticProbeRepo } from '@/db/repositories/synthetic-probe-repos.js';
import {
  PROBE_TENANT_ID,
  PROBE_AGENT_ID,
  PROBE_CHANNEL_ID,
  PROBE_CONTEXT,
} from '@/probe/constants.js';

async function main(): Promise<void> {
  const active = !process.argv.includes('--deactivate');

  await runWithTenantContext(PROBE_CONTEXT, async () => {
    const res = await syntheticProbeRepo.setChannelActive(
      { tenant_id: PROBE_TENANT_ID, agent_id: PROBE_AGENT_ID, channel_id: PROBE_CHANNEL_ID },
      active,
    );
    if (!res) {
      throw new Error(
        `Recusando: o canal ${PROBE_CHANNEL_ID} não existe ou NÃO é is_synthetic ` +
          `(o predicado atômico exige is_synthetic=true). Rode a migração 094.`,
      );
    }
    // Toda mudança de estado de roteamento/governança audita.
    await audit({
      acao: 'synthetic_probe_channel_activation',
      metadata: { channel_id: PROBE_CHANNEL_ID, active: res.active },
    });
    console.log(
      `Canal de sonda ${PROBE_CHANNEL_ID} agora active=${res.active}. ` +
        (res.active
          ? 'Ligue MAIA_SYNTHETIC_PROBE=true (em exact_first/strict) para a sonda rodar.'
          : 'Sonda desativada (o worker no-opa por não-prontidão do canal).'),
    );
  });
}

main()
  .then(() => shutdownDb())
  .catch(async (err) => {
    console.error((err as Error).message);
    await shutdownDb();
    process.exit(1);
  });
