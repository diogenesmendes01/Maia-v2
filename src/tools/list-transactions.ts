import { z } from 'zod';
import { transacoesRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categoria_id: z.string().uuid().optional(),
  natureza: z.enum(['receita', 'despesa', 'movimentacao']).optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});

const outputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      data_competencia: z.string(),
      natureza: z.string(),
      valor: z.number(),
      descricao: z.string(),
      categoria_id: z.string().nullable(),
      status: z.string(),
    }),
  ),
});

export const listTransactionsTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'list_transactions',
  description: 'Lista transações de uma entidade com filtros opcionais.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_transactions'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested', // closest read action; consider adding 'transactions_listed'
  handler: async (args, ctx) => {
    if (!ctx.scope.entidades.includes(args.entidade_id)) {
      return { items: [] };
    }
    const rows = await transacoesRepo.byScope(
      { pessoa_id: ctx.pessoa.id, entidades: [args.entidade_id] },
      {
        date_from: args.date_from,
        date_to: args.date_to,
        categoria_id: args.categoria_id,
        natureza: args.natureza,
        limit: args.limit,
        offset: args.offset,
      },
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        data_competencia: r.data_competencia,
        natureza: r.natureza,
        valor: Number(r.valor),
        descricao: r.descricao,
        categoria_id: r.categoria_id,
        status: r.status,
      })),
    };
  },
};
