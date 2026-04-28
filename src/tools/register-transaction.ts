import { z } from 'zod';
import { contasRepo, transacoesRepo, contrapartesRepo, categoriasRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';
import { trigramSim } from '@/lib/utils.js';
import { TypedError } from '@/lib/utils.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid(),
  conta_id: z.string().uuid(),
  natureza: z.enum(['receita', 'despesa', 'movimentacao']),
  valor: z.number().positive(),
  data_competencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  data_pagamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pendente', 'agendada', 'paga', 'recebida']),
  descricao: z.string().min(1).max(280),
  categoria_id: z.string().uuid().optional(),
  contraparte_id: z.string().uuid().optional(),
  contraparte_nome: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  origem: z.enum(['whatsapp', 'manual']).default('whatsapp'),
});

const outputSchema = z.union([
  z.object({
    transacao_id: z.string().uuid(),
    saldo_apos: z.number(),
  }),
  z.object({
    duplicate_suspected: z.literal(true),
    existing: z.object({
      transacao_id: z.string(),
      data_competencia: z.string(),
      valor: z.number(),
      descricao: z.string(),
    }),
  }),
]);

export const registerTransactionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'register_transaction',
  description:
    'Registra uma transação financeira (receita, despesa ou movimentação) em uma conta de uma entidade. Sempre valor positivo; o sinal vem da natureza.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_transaction'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'transaction_created',
  handler: async (args, ctx) => {
    const conta = await contasRepo.byId(args.conta_id);
    if (!conta) throw new TypedError('conta_not_found', 'conta não existe');
    if (conta.entidade_id !== args.entidade_id) {
      throw new TypedError('entidade_conta_mismatch', 'a conta não pertence à entidade indicada');
    }

    // Semantic dedup (layer 3): check recent similar
    const recent = await transacoesRepo.findRecentSimilar({
      entidade_id: args.entidade_id,
      valor: args.valor.toFixed(2),
      descricao: args.descricao,
      registrado_por: ctx.pessoa.id,
      sinceMs: 2 * 60 * 60 * 1000,
    });
    const sim = recent.find((t) => trigramSim(t.descricao, args.descricao) > 0.85);
    if (sim) {
      return {
        duplicate_suspected: true as const,
        existing: {
          transacao_id: sim.id,
          data_competencia: sim.data_competencia,
          valor: Number(sim.valor),
          descricao: sim.descricao,
        },
      };
    }

    let categoria_id = args.categoria_id ?? null;
    if (!categoria_id) {
      const generic = await categoriasRepo.byNomeNatureza(
        args.natureza === 'receita' ? 'Outras receitas' : 'Outras despesas',
        args.natureza === 'movimentacao' ? 'movimentacao' : args.natureza,
      );
      categoria_id = generic?.id ?? null;
    }

    let contraparte_id = args.contraparte_id ?? null;
    if (!contraparte_id && args.contraparte_nome) {
      // Optionally lookup or fallback to text-only field; do not auto-create here (4-eyes).
    }

    const t = await transacoesRepo.create({
      entidade_id: args.entidade_id,
      conta_id: args.conta_id,
      categoria_id,
      natureza: args.natureza,
      valor: args.valor.toFixed(2),
      data_competencia: args.data_competencia,
      data_pagamento: args.data_pagamento ?? null,
      status: args.status,
      descricao: args.descricao,
      contraparte: args.contraparte_nome ?? null,
      contraparte_id,
      origem: args.origem,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      registrado_por: ctx.pessoa.id,
      confianca_ia: null,
      confirmada_em: null,
      metadata: args.metadata ?? {},
    });

    let saldo_apos = Number(conta.saldo_atual);
    if (args.status === 'paga' || args.status === 'recebida') {
      const sign = args.natureza === 'receita' ? 1 : args.natureza === 'despesa' ? -1 : 0;
      const updated = await contasRepo.addToBalance(conta.id, sign * args.valor);
      saldo_apos = updated ? Number(updated.saldo_atual) : saldo_apos;
    }

    return { transacao_id: t.id, saldo_apos };
  },
};
