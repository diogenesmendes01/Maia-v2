import { z } from 'zod';
import { contasRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';
import { sumDecimal, toDecimal } from '@/lib/decimal.js';

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
  sensitive: true,
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
    // saldo_atual vem como string (numeric driver pg). Soma é feita em
    // Decimal pra preservar precisão; convertemos pra number SOMENTE
    // no boundary de saída do tool (output_schema é z.number()).
    const out = contas.map((c) => ({
      id: c.id,
      apelido: c.apelido,
      saldo: toDecimal(c.saldo_atual).toNumber(),
      banco: c.banco,
      entidade_id: c.entidade_id,
    }));
    const total = sumDecimal(contas.map((c) => c.saldo_atual)).toNumber();
    return { contas: out, total };
  },
};
