/**
 * list_pending_proposals — owner-facing P5 closure tool. Lista capability
 * proposals com status='submitted' (ou outro filtro) do tenant atual.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  capability_type: z
    .enum(['tool', 'knowledge', 'procedure', 'integration', 'other', 'holiday'])
    .optional(),
});

const outputSchema = z.object({
  proposals: z.array(
    z.object({
      id: z.string(),
      capability_type: z.string(),
      title: z.string(),
      description: z.string(),
      motivation: z.string(),
      expected_impact: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const listPendingProposalsTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'list_pending_proposals',
  description:
    'Lista capability proposals pendentes (status=submitted) para o owner aprovar ou rejeitar. Filtro opcional por capability_type (holiday, tool, knowledge, procedure, ...).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'calendar_query',
  handler: async (args) => {
    const all = await capabilityProposalsRepo.listByStatus('submitted');
    const filtered = args.capability_type
      ? all.filter((p) => p.capability_type === args.capability_type)
      : all;
    return {
      proposals: filtered.map((p) => ({
        id: p.id,
        capability_type: p.capability_type,
        title: p.title,
        description: p.description,
        motivation: p.motivation,
        expected_impact: p.expected_impact,
        created_at: p.created_at?.toISOString() ?? '',
      })),
      total: filtered.length,
    };
  },
};
