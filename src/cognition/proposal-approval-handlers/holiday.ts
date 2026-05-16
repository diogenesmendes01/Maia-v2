/**
 * Handler de aprovação para proposals de tipo 'holiday'. Lê o payload em
 * proposal.proposed_spec, cria a row em holidays, vincula entidades se aplicável,
 * e invalida cache do tenant. Idempotente.
 */
import { holidaysRepo } from '@/db/repositories/holidays-repo.js';
import { holidayEntidadesRepo } from '@/db/repositories/holiday-entidades-repo.js';
import { invalidateCacheForHolidayChange } from '@/lib/holidays-cache.js';
import { getCurrentTenant } from '@/db/tenant-context.js';
import type { CapabilityProposal } from '@/db/schema.js';
import type { HolidayDescriptorPayload } from '../holiday-descriptor.js';

export async function approveHoliday(
  proposal: CapabilityProposal,
  args: { approverId: string },
): Promise<{ status: 'approved'; holiday_id: number; idempotent: boolean }> {
  const tenant_id = getCurrentTenant();
  // idempotent — se já existe holiday vinculado a esse proposal_id, retorna.
  const existing = await holidaysRepo.findByProposalId(proposal.id);
  if (existing) {
    return { status: 'approved', holiday_id: existing.id, idempotent: true };
  }

  const payload = proposal.proposed_spec as unknown as HolidayDescriptorPayload;
  if (!payload || !payload.name || !payload.month || !payload.day || !payload.type) {
    throw new Error(`approveHoliday: missing fields in proposal.proposed_spec: ${JSON.stringify(payload)}`);
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
  if (
    payload.entidade_id &&
    payload.entidade_id !== 'global' &&
    (payload.type === 'entity_custom' || payload.type === 'holding_recess')
  ) {
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
