/**
 * approve_capability_proposal — P5 closure tool genérica. Delega ao
 * dispatcher por capability_type. Para holiday: cria holiday + invalida cache.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import { dispatchApproval } from '@/cognition/proposal-approval-handler.js';

const inputSchema = z.object({
  proposal_id: z.string().uuid(),
  decision_reason: z.string().optional(),
});

const outputSchema = z.object({
  proposal_id: z.string(),
  status: z.string(),
  capability_type: z.string(),
  holiday_id: z.number().nullable(),
});

export const approveCapabilityProposalTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'approve_capability_proposal',
  description:
    'Aprova uma capability proposal pendente. Para holiday: cria o feriado na tabela. Para outros tipos: marca como aprovada (entrega depende do tipo).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['manage_calendar'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'capability_proposal_approved',
  handler: async (args, ctx) => {
    const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
    if (!proposal) throw new Error(`proposal not found: ${args.proposal_id}`);
    if (proposal.status !== 'submitted') {
      throw new Error(`proposal status is '${proposal.status}', cannot approve`);
    }

    // 1) Transição submitted → approved
    const approverId = ctx.pessoa?.id ?? 'owner';
    const t = await capabilityProposalsRepo.transition({
      id: args.proposal_id,
      to: 'approved',
      decided_by: approverId,
      decision_reason: args.decision_reason,
    });
    if (!t.ok) {
      throw new Error(`transition failed: ${t.reason}`);
    }

    // 2) Dispatch ao handler do tipo
    const result = await dispatchApproval(proposal, { approverId });

    return {
      proposal_id: args.proposal_id,
      status: 'approved',
      capability_type: proposal.capability_type,
      holiday_id: 'holiday_id' in result ? result.holiday_id : null,
    };
  },
};
