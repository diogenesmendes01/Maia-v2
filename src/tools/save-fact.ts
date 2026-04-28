import { z } from 'zod';
import type { Tool } from './_registry.js';
import { saveFact as saveFactInMemory } from '@/memory/semantic.js';

const inputSchema = z.object({
  escopo: z.string().regex(/^(global|pessoa:[0-9a-f-]+|entidade:[0-9a-f-]+)$/),
  chave: z.string().min(1).max(120),
  valor: z.unknown(),
  fonte: z.enum(['configurado', 'aprendido', 'inferido']).default('aprendido'),
  confianca: z.number().min(0).max(1).optional(),
});

const outputSchema = z.object({
  fact_id: z.string(),
});

export const saveFactTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'save_fact',
  description: 'Salva um fato sobre o mundo (preferência, regra de negócio do usuário, etc.). Backend valida escopo.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'fact_saved',
  handler: async (args, ctx) => {
    // Backend enforces escopo against caller's scope
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
    const f = await saveFactInMemory({
      escopo: args.escopo,
      chave: args.chave,
      valor: args.valor,
      fonte: args.fonte,
      confianca: args.confianca,
    });
    return { fact_id: f.id };
  },
};
