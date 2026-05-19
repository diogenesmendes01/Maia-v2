/**
 * Handler de aprovação para proposals de tipo 'holiday'. Lê o payload em
 * proposal.proposed_spec, cria a row em holidays, vincula entidades se aplicável,
 * e invalida cache do tenant. Idempotente.
 *
 * Codex review #105 round-2 (high): a aprovação tem dois passos com efeitos
 * independentes (INSERT em holidays + INSERT em holiday_entidades). Se o
 * primeiro commita e o segundo falha (lock contention, network blip,
 * cross-tenant pre-check race), o proposal permanece em `submitted` e um
 * retry caía no early-return idempotente — pulando o link faltante e
 * deixando um feriado órfão para `entity_custom` / `holding_recess` (cuja
 * aplicabilidade depende exclusivamente da junction). O `approve_capability_
 * proposal` então transicionava o proposal para `approved` confirmando uma
 * aprovação que NÃO afeta entidade nenhuma.
 *
 * Fix: o path idempotente agora reconcilia o link esperado (faz o link se
 * ele estiver faltando) e re-invalida cache antes de retornar success. Isso
 * fecha a janela: cada retry converge para o estado terminal correto, e o
 * `approve_capability_proposal` só vai transicionar depois que o link
 * estiver garantido.
 */
import { holidaysRepo } from '@/db/repositories/holidays-repo.js';
import { holidayEntidadesRepo } from '@/db/repositories/holiday-entidades-repo.js';
import { invalidateCacheForHolidayChange } from '@/lib/holidays-cache.js';
import { getCurrentTenant } from '@/db/tenant-context.js';
import type { CapabilityProposal } from '@/db/schema.js';
import type { HolidayDescriptorPayload } from '../holiday-descriptor.js';

/**
 * Verifica se o payload exige link em holiday_entidades.
 * Apenas entity_custom / holding_recess com entidade_id concreto (não "global").
 */
function requiresEntityLink(payload: HolidayDescriptorPayload): boolean {
  return Boolean(
    payload.entidade_id &&
      payload.entidade_id !== 'global' &&
      (payload.type === 'entity_custom' || payload.type === 'holding_recess'),
  );
}

export async function approveHoliday(
  proposal: CapabilityProposal,
  args: { approverId: string },
): Promise<{ status: 'approved'; holiday_id: number; idempotent: boolean }> {
  const tenant_id = getCurrentTenant();

  const payload = proposal.proposed_spec as unknown as HolidayDescriptorPayload;
  if (!payload || !payload.name || !payload.month || !payload.day || !payload.type) {
    throw new Error(`approveHoliday: missing fields in proposal.proposed_spec: ${JSON.stringify(payload)}`);
  }

  // Codex review #105 round-2 (high): caminho idempotente reconcilia link.
  // Se já existe holiday para esse proposal_id mas o link em holiday_entidades
  // está faltando (rollback parcial: INSERT commitado, link falhou), terminamos
  // o trabalho aqui em vez de fingir que tudo aprovou. Isso garante que a
  // transição submitted → approved no caller só rode com state consistente.
  const existing = await holidaysRepo.findByProposalId(proposal.id);
  if (existing) {
    if (requiresEntityLink(payload)) {
      const linkedIds = await holidayEntidadesRepo.listByEntidade(payload.entidade_id);
      const alreadyLinked = linkedIds.includes(existing.id);
      if (!alreadyLinked) {
        // Reconcile: faz o link que faltou. Se isso lançar (ex.: cross-tenant),
        // propaga — o caller mantém proposal em `submitted` para retry.
        await holidayEntidadesRepo.link({
          holiday_id: existing.id,
          entidade_id: payload.entidade_id,
        });
        // Cache pode estar stale com o estado órfão; invalida.
        invalidateCacheForHolidayChange(
          { tenant_id, type: payload.type, entidade_ids: [payload.entidade_id] },
          { changeKind: 'create' },
        );
      }
    }
    return { status: 'approved', holiday_id: existing.id, idempotent: true };
  }

  const created = await holidaysRepo.create({
    name: payload.name,
    month: payload.month,
    day: payload.day,
    year: payload.year,
    type: payload.type,
    uf: payload.uf,
    cidade: payload.cidade,
    proposal_id: proposal.id,
    status: 'ativo',
    source: 'pipeline',
    approved_by: args.approverId,
  });

  // Vincula entidade se for entity_custom / holding_recess (entidade_id != "global").
  // Se o link falhar (cross-tenant, dup, etc.), propagamos — o INSERT em
  // holidays já commitou, mas o caller (approve-capability-proposal) NÃO vai
  // transicionar o proposal para `approved`, e o próximo retry cai no path
  // idempotente acima e reconcilia o link.
  if (requiresEntityLink(payload)) {
    await holidayEntidadesRepo.link({
      holiday_id: created.id,
      entidade_id: payload.entidade_id,
    });
  }

  invalidateCacheForHolidayChange(
    { tenant_id, type: payload.type, entidade_ids: [payload.entidade_id] },
    { changeKind: 'create' },
  );

  return { status: 'approved', holiday_id: created.id, idempotent: false };
}
