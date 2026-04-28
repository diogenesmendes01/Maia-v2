import { z } from 'zod';
import { rulesRepo, categoriasRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';
import { trigramSim, stripDiacritics } from '@/lib/utils.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid(),
  descricao: z.string().min(1),
  contraparte: z.string().optional(),
  natureza: z.enum(['receita', 'despesa', 'movimentacao']).optional(),
});

const outputSchema = z.object({
  categoria_id: z.string().nullable(),
  categoria_nome: z.string().nullable(),
  confianca: z.number().min(0).max(1),
  rules_applied: z.array(z.string()),
  suggestions: z.array(
    z.object({
      categoria_id: z.string(),
      categoria_nome: z.string(),
      confianca: z.number(),
    }),
  ),
});

export const classifyTransactionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'classify_transaction',
  description:
    'Sugere uma categoria para uma transação dada sua descrição. Considera regras aprendidas e similaridade com categorias existentes.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_transactions'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested',
  handler: async (args, ctx) => {
    if (!ctx.scope.entidades.includes(args.entidade_id)) {
      return {
        categoria_id: null,
        categoria_nome: null,
        confianca: 0,
        rules_applied: [],
        suggestions: [],
      };
    }
    const rules = await rulesRepo.listActive('classificacao');
    const desc = stripDiacritics(args.descricao.toLowerCase());

    const rules_applied: string[] = [];
    let bestRule: { categoria_id: string; confianca: number } | null = null;

    for (const r of rules) {
      const ctxJ = (r.contexto_jsonb ?? {}) as { contains?: string; entidade_id?: string };
      if (ctxJ.entidade_id && ctxJ.entidade_id !== args.entidade_id) continue;
      const needle = ctxJ.contains ? stripDiacritics(String(ctxJ.contains).toLowerCase()) : '';
      if (needle && desc.includes(needle)) {
        const acoes = (r.acoes_jsonb ?? {}) as { categoria_id?: string };
        if (acoes.categoria_id) {
          rules_applied.push(r.id);
          const cf = Number(r.confianca);
          if (!bestRule || cf > bestRule.confianca) bestRule = { categoria_id: acoes.categoria_id, confianca: cf };
        }
      }
    }

    const cats = await categoriasRepo.list({ pessoa_id: ctx.pessoa.id, entidades: [args.entidade_id] });
    const filtered = args.natureza ? cats.filter((c) => c.natureza === args.natureza) : cats;
    const scored = filtered
      .map((c) => ({
        categoria_id: c.id,
        categoria_nome: c.nome,
        confianca: trigramSim(desc, stripDiacritics(c.nome.toLowerCase())),
      }))
      .filter((s) => s.confianca > 0.15)
      .sort((a, b) => b.confianca - a.confianca)
      .slice(0, 5);

    if (bestRule) {
      const cat = await categoriasRepo.byId(bestRule.categoria_id);
      return {
        categoria_id: bestRule.categoria_id,
        categoria_nome: cat?.nome ?? null,
        confianca: bestRule.confianca,
        rules_applied,
        suggestions: scored,
      };
    }

    if (scored.length > 0) {
      const top = scored[0]!;
      return {
        categoria_id: top.categoria_id,
        categoria_nome: top.categoria_nome,
        confianca: top.confianca,
        rules_applied,
        suggestions: scored,
      };
    }
    return {
      categoria_id: null,
      categoria_nome: null,
      confianca: 0,
      rules_applied,
      suggestions: [],
    };
  },
};
