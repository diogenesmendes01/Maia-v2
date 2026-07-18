/**
 * Ativa (ou desativa) o canal da SONDA SINTÉTICA — o caminho de ativação SEGURO
 * e documentado (spec §1.2 / correção do review R2).
 *
 * Por quê um script, e não o pareamento Baileys: o canal da sonda usa uma linha
 * placeholder (`+999...`) que NENHUMA conta WhatsApp real pode provar posse —
 * então o fluxo de pareamento (que compara o número reportado pelo Baileys com
 * a linha declarada) SEMPRE falharia. A sonda não precisa de sessão real: o
 * inbound é injetado sinteticamente e TODO o outbound é interceptado pelo sink
 * (por triplete + is_synthetic). O único motivo de o canal precisar de
 * `active=true` é para o exact-match do `resolveChannel` resolver a injeção para
 * o canal de sonda (senão cairia no catch-all `primary/primary` — tenant real).
 *
 * GUARDAS (fail-closed):
 *   - o canal DEVE ser exclusivamente sintético (is_synthetic=true, tenant ≠
 *     primary) — nunca ativamos um canal real por engano;
 *   - MAIA_CHANNEL_ROUTING_MODE ∈ {exact_first, strict} — ativar sob `shadow`
 *     derrubaria o catch-all real (findPrimaryCatchAllChannel ⇒ multi_tenant).
 *
 * ⚠️  ATENÇÃO: num deployment que DEPENDE do catch-all (mono-linha, primary/
 * primary respondendo remetentes desconhecidos), ativar um canal de outro
 * tenant faz `findPrimaryCatchAllChannel` retornar multi_tenant:true — a partir
 * daí remetentes desconhecidos passam a FALHAR FECHADO em vez de cair no
 * catch-all. Só ative a sonda em ambiente de roteamento por exact-match, onde o
 * tráfego real é resolvido pela própria linha (spec §1.2/§5).
 *
 * Uso:
 *   tsx scripts/activate-synthetic-probe.ts            # ativa
 *   tsx scripts/activate-synthetic-probe.ts --deactivate
 */
import { eq, and } from 'drizzle-orm';
import { config } from '@/config/env.js';
import { db, shutdownDb } from '@/db/client.js';
import { channels } from '@/db/schema.js';
import { PRIMARY_TENANT_ID } from '@/db/tenant-context.js';
import { PROBE_TENANT_ID, PROBE_AGENT_ID, PROBE_CHANNEL_ID } from '@/probe/constants.js';

async function main(): Promise<void> {
  const deactivate = process.argv.includes('--deactivate');

  if (!deactivate && config.MAIA_CHANNEL_ROUTING_MODE === 'shadow') {
    throw new Error(
      'Recusando ativar sob MAIA_CHANNEL_ROUTING_MODE=shadow — um canal ativo de ' +
        'tenant ≠ primary derrubaria o catch-all real. Rode em exact_first/strict.',
    );
  }

  const rows = await db
    .select({ is_synthetic: channels.is_synthetic, tenant_id: channels.tenant_id, active: channels.active })
    .from(channels)
    .where(
      and(
        eq(channels.id, PROBE_CHANNEL_ID),
        eq(channels.tenant_id, PROBE_TENANT_ID),
        eq(channels.agent_id, PROBE_AGENT_ID),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Canal de sonda ${PROBE_CHANNEL_ID} não encontrado — rode a migração 094.`);
  if (!row.is_synthetic) throw new Error('Recusando: o canal alvo NÃO é is_synthetic. Nunca ativo um canal real.');
  if (row.tenant_id === PRIMARY_TENANT_ID) throw new Error('Recusando: o canal alvo está no tenant primary.');

  const active = !deactivate;
  await db
    .update(channels)
    .set({ active, updated_at: new Date() })
    .where(
      and(
        eq(channels.id, PROBE_CHANNEL_ID),
        eq(channels.tenant_id, PROBE_TENANT_ID),
        eq(channels.agent_id, PROBE_AGENT_ID),
      ),
    );

  console.log(
    `Canal de sonda ${PROBE_CHANNEL_ID} agora active=${active} ` +
      `(routing_mode=${config.MAIA_CHANNEL_ROUTING_MODE}). ` +
      (active
        ? 'Ligue MAIA_SYNTHETIC_PROBE=true para a sonda começar a rodar.'
        : 'Sonda desativada (o worker no-opa por não-prontidão do canal).'),
  );
}

main()
  .then(() => shutdownDb())
  .catch(async (err) => {
    console.error((err as Error).message);
    await shutdownDb();
    process.exit(1);
  });
