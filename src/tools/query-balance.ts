import { z } from 'zod';
import { contasRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  conta_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  contas: z.array(
    z.object({
      id: z.string(),
      apelido: z.string(),
      saldo: z.number(),
      banco: z.string(),
      entidade_id: z.string(),
    }),
  ),
  total: z.number(),
});

export const queryBalanceTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'query_balance',
  description:
    'Consulta saldos das contas bancárias de uma entidade ou de uma conta específica. Sem args, retorna saldos de todas as contas no escopo.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'balance_queried',
  handler: async (args, ctx) => {
    let contas;
    if (args.conta_id) {
      const c = await contasRepo.byId(args.conta_id);
      contas = c && ctx.scope.entidades.includes(c.entidade_id) ? [c] : [];
    } else if (args.entidade_id) {
      if (!ctx.scope.entidades.includes(args.entidade_id)) {
        return { contas: [], total: 0 };
      }
      contas = await contasRepo.byEntity(args.entidade_id);
    } else {
      contas = await contasRepo.byEntities({ pessoa_id: ctx.pessoa.id, entidades: ctx.scope.entidades });
    }
    const out = contas.map((c) => ({
      id: c.id,
      apelido: c.apelido,
      saldo: Number(c.saldo_atual),
      banco: c.banco,
      entidade_id: c.entidade_id,
    }));
    return { contas: out, total: out.reduce((s, c) => s + c.saldo, 0) };
  },
};
