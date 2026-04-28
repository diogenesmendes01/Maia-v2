import { z } from 'zod';
import { entidadesRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';
import { trigramSim, stripDiacritics } from '@/lib/utils.js';

const inputSchema = z.object({
  texto: z.string().min(1),
});

const outputSchema = z.object({
  entidade_id: z.string().nullable(),
  confianca: z.number().min(0).max(1),
  alternativas: z.array(z.object({ entidade_id: z.string(), nome: z.string(), score: z.number() })),
  ambiguous: z.boolean(),
});

export const identifyEntityTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'identify_entity',
  description:
    'Tenta inferir qual entidade do escopo do interlocutor o usuário está mencionando. Se ambíguo, retorna ambiguous=true e a Maia deve perguntar.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_balance'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested',
  handler: async (args, ctx) => {
    if (ctx.scope.entidades.length === 0) {
      return { entidade_id: null, confianca: 0, alternativas: [], ambiguous: true };
    }
    const ents = await entidadesRepo.byIds(ctx.scope.entidades);
    const t = stripDiacritics(args.texto.toLowerCase());
    const scored = ents
      .map((e) => ({ entidade_id: e.id, nome: e.nome, score: trigramSim(t, stripDiacritics(e.nome.toLowerCase())) }))
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { entidade_id: null, confianca: 0, alternativas: [], ambiguous: true };
    const top = scored[0]!;
    const second = scored[1];
    const ambiguous = top.score < 0.4 || (second !== undefined && top.score - second.score < 0.1);
    return {
      entidade_id: ambiguous ? null : top.entidade_id,
      confianca: top.score,
      alternativas: scored.slice(0, 5),
      ambiguous,
    };
  },
};
