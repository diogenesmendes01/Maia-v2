/**
 * [DEPRECATED até P11] `save_fact` — agora wrapper para `propose_fact`.
 *
 * P10a Knowledge State Machine intercepta toda escrita de fato. Rows
 * podem cair em `pending_review` se risk > low — owner deve auditar
 * callers durante canary. TTL de remoção: P11.
 */

import { z } from 'zod';
import type { Tool } from './_registry.js';
import { logger } from '@/lib/logger.js';
import { proposeFactTool } from './propose-fact.js';

const inputSchema = z.object({
  escopo: z
    .string()
    .regex(/^(global|pessoa:[0-9a-f-]+|entidade:[0-9a-f-]+)$/),
  chave: z.string().min(1).max(120),
  valor: z.unknown(),
  fonte: z
    .enum(['configurado', 'aprendido', 'inferido'])
    .default('aprendido'),
  confianca: z.number().min(0).max(1).optional(),
});

const outputSchema = z.object({
  fact_id: z.string(),
});

export const saveFactTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'save_fact',
  description:
    '[DEPRECATED até P11] Use propose_fact. save_fact agora propõe via Knowledge State Machine — pode cair em pending_review se risk elevado.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  effect_class: 'non_interruptible',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'fact_saved',
  handler: async (args, ctx) => {
    logger.warn(
      {
        tool: 'save_fact',
        caller_pessoa_id: ctx.pessoa.id,
        chave: args.chave,
      },
      'deprecation_warning_save_fact',
    );

    // Backend enforces escopo against caller's scope.
    if (args.escopo.startsWith('entidade:')) {
      const eid = args.escopo.split(':')[1] ?? '';
      if (!ctx.scope.entidades.includes(eid)) {
        throw new Error('escopo_outside_scope');
      }
    }
    if (args.escopo.startsWith('pessoa:')) {
      const pid = args.escopo.split(':')[1] ?? '';
      if (pid !== ctx.pessoa.id) {
        throw new Error('escopo_outside_scope');
      }
    }

    // Route through KSM. The proposal_id is the new fact_id surface
    // (it's the same UUID — agent_facts.id).
    const result = await proposeFactTool.handler(
      {
        escopo: args.escopo,
        chave: args.chave,
        valor: args.valor,
        texto:
          typeof args.valor === 'string'
            ? args.valor
            : `${args.chave}: ${JSON.stringify(args.valor)}`,
        fonte: args.fonte,
        confianca: args.confianca ?? 0.6,
      },
      ctx,
    );
    return { fact_id: result.proposal_id };
  },
};
