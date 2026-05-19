/**
 * reject_capability_proposal — P5 closure tool genérica. Marca proposta como
 * rejected (terminal). Não invalida cache (nada criado).
 *
 * Codex review #105 round-2 (high): mesma armadilha de scope leakage de
 * `approve_capability_proposal`. Rejeitar incorretamente é menos perigoso
 * do que aprovar mas ainda é um vetor para usuários com `manage_calendar`
 * em uma entidade descartarem proposals tenant-level / de outras entidades.
 * Fix: required_actions=`manage_capabilities` no dispatcher + segunda
 * checagem `manage_calendar` contra `proposed_spec.entidade_id` para
 * holiday com entidade alvo.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import { canAct } from '@/governance/permissions.js';
import { FeatureFlagName } from '@/types/enums.js';
import type { HolidayDescriptorPayload } from '@/cognition/holiday-descriptor.js';

const inputSchema = z.object({
  proposal_id: z.string().uuid(),
  reason: z.string().min(1),
});

const outputSchema = z.object({
  proposal_id: z.string(),
  status: z.string(),
});

export const rejectCapabilityProposalTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'reject_capability_proposal',
  description: 'Rejeita uma capability proposal pendente. Estado terminal.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['manage_capabilities'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'capability_proposal_rejected',
  feature_flag: FeatureFlagName.CALENDAR_V2,
  handler: async (args, ctx) => {
    const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
    if (!proposal) throw new Error(`proposal not found: ${args.proposal_id}`);

    // Codex review #105 round-2 (high): segunda checagem por proposta (idem
    // approve). Para holiday com entidade alvo, exige manage_calendar nessa
    // entidade. Para outros tipos, manage_capabilities (checado no dispatcher)
    // basta.
    if (proposal.capability_type === 'holiday') {
      const payload = proposal.proposed_spec as unknown as Partial<HolidayDescriptorPayload>;
      const targetEntidadeId = payload?.entidade_id;
      if (
        targetEntidadeId &&
        targetEntidadeId !== 'global' &&
        (payload?.type === 'entity_custom' || payload?.type === 'holding_recess')
      ) {
        if (!ctx.scope.entidades.includes(targetEntidadeId)) {
          throw new Error(
            `entidade alvo do proposal fora do escopo: ${targetEntidadeId}`,
          );
        }
        const resolved = ctx.scope.byEntity.get(targetEntidadeId);
        const allow = canAct({
          pessoa: ctx.pessoa,
          resolved: resolved ?? null,
          action: 'manage_calendar',
        });
        if (!allow.allowed) {
          throw new Error(
            `sem permissão manage_calendar na entidade alvo ${targetEntidadeId}: ${allow.reason}`,
          );
        }
      }
    }

    const approverId = ctx.pessoa?.id ?? 'owner';
    const t = await capabilityProposalsRepo.transition({
      id: args.proposal_id,
      to: 'rejected',
      decided_by: approverId,
      decision_reason: args.reason,
    });
    if (!t.ok) {
      throw new Error(`reject failed: ${t.reason}`);
    }
    return { proposal_id: args.proposal_id, status: 'rejected' };
  },
};
