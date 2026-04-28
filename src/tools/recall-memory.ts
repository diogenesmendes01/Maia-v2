import { z } from 'zod';
import type { Tool } from './_registry.js';
import { recall } from '@/memory/vector.js';

const inputSchema = z.object({
  query: z.string().min(1),
  tipos: z.array(z.string()).optional(),
  k: z.number().int().positive().max(20).default(5),
});

const outputSchema = z.object({
  items: z.array(
    z.object({
      conteudo: z.string(),
      tipo: z.string(),
      score: z.number(),
    }),
  ),
});

export const recallMemoryTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'recall_memory',
  description: 'Busca memórias passadas por similaridade semântica dentro do escopo do interlocutor.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_transactions'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'memory_recalled',
  handler: async (args, ctx) => {
    const escopos = [
      'global',
      `pessoa:${ctx.pessoa.id}`,
      ...ctx.scope.entidades.map((e) => `entidade:${e}`),
    ];
    const items = await recall({ query: args.query, escopo: escopos, tipos: args.tipos, k: args.k });
    return { items: items.map((i) => ({ conteudo: i.conteudo, tipo: i.tipo, score: i.score })) };
  },
};
