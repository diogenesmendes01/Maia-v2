/**
 * reject_capability_proposal — P5 closure tool genérica. Marca proposta como
 * rejected (terminal). Não invalida cache (nada criado).
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';

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
  required_actions: ['manage_calendar'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'capability_proposal_rejected',
  handler: async (args, ctx) => {
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
