import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo, contasRepo, entidadesRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  entidade_ids: z.array(z.string().uuid()).min(1),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const outputSchema = z.object({
  rows: z.array(
    z.object({
      entidade_id: z.string(),
      entidade_nome: z.string(),
      receita: z.number(),
      despesa: z.number(),
      lucro: z.number(),
      caixa_final: z.number(),
    }),
  ),
  consolidado: z.object({
    receita: z.number(),
    despesa: z.number(),
    lucro: z.number(),
    caixa_final: z.number(),
  }),
});

export const compareEntitiesTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'compare_entities',
  description: 'Comparativo financeiro entre entidades em um período (receitas, despesas, lucro, caixa final).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_reports'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested',
  sensitive: true,
  handler: async (args, ctx) => {
    const allowed = args.entidade_ids.filter((id) => ctx.scope.entidades.includes(id));
    const ents = await entidadesRepo.byIds(allowed);
    const rows = [];
    let totReceita = 0,
      totDespesa = 0,
      totCaixa = 0;
    for (const e of ents) {
      const txns = await transacoesRepo.byScope(
        { pessoa_id: ctx.pessoa.id, entidades: [e.id] },
        { date_from: args.date_from, date_to: args.date_to, limit: 1000 },
      );
      const receita = txns.filter((t) => t.natureza === 'receita').reduce((s, t) => s + Number(t.valor), 0);
      const despesa = txns.filter((t) => t.natureza === 'despesa').reduce((s, t) => s + Number(t.valor), 0);
      const lucro = receita - despesa;
      const contas = await contasRepo.byEntity(e.id);
      const caixa_final = contas.reduce((s, c) => s + Number(c.saldo_atual), 0);
      rows.push({
        entidade_id: e.id,
        entidade_nome: e.nome,
        receita,
        despesa,
        lucro,
        caixa_final,
      });
      totReceita += receita;
      totDespesa += despesa;
      totCaixa += caixa_final;
    }
    return {
      rows,
      consolidado: {
        receita: totReceita,
        despesa: totDespesa,
        lucro: totReceita - totDespesa,
        caixa_final: totCaixa,
      },
    };
  },
};
