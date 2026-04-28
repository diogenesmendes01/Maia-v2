import { z } from 'zod';
import type { Tool } from './_registry.js';
import { rulesRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  tipo: z.enum(['classificacao', 'identificacao_entidade', 'tom_resposta', 'recorrencia']),
  contexto: z.string().min(1),
  acao: z.string().min(1),
  contexto_jsonb: z.record(z.unknown()).default({}),
  acoes_jsonb: z.record(z.unknown()).default({}),
  exemplo_origem_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  rule_id: z.string(),
  status: z.enum(['probatoria']),
});

export const saveRuleTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'save_rule',
  description:
    'Cria uma regra aprendida em estado probatório. Nunca cria como firme; promoção ocorre por reflexão.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'rule_learned',
  handler: async (args) => {
    const r = await rulesRepo.create({
      tipo: args.tipo,
      contexto: args.contexto,
      acao: args.acao,
      contexto_jsonb: args.contexto_jsonb,
      acoes_jsonb: args.acoes_jsonb,
      confianca: '0.50',
      acertos: 0,
      erros: 0,
      ativa: true,
      exemplo_origem_id: args.exemplo_origem_id ?? null,
    });
    return { rule_id: r.id, status: 'probatoria' };
  },
};
