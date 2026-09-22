import { z } from 'zod';
import type { Tool } from './_registry.js';
import { recallAuthorized } from '@/memory/recall-authorized.js';

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
  description:
    'Busca memórias passadas por similaridade semântica dentro do escopo do interlocutor.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_transactions'],
  /**
   * C-P05-7 (§7.10.1) — a autorização é sobre o TITULAR da conversa, não sobre
   * uma entidade.
   *
   * Sem esta linha, o dispatcher exigia entidade e, quando os argumentos não
   * traziam uma, caía em `ctx.scope.entidades[0]`: a chamada ficava vinculada a
   * uma entidade arbitrária e as checagens rodavam contra ela. Num escopo SEM
   * entidade, a mesma chamada era recusada com `no_entity_in_scope` — um
   * problema que memória pessoal não tem. A spec é literal: "memória pessoal
   * não pode inventar entidade para passar esse gate".
   */
  authorization_target: 'current_subject',
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'memory_recalled',
  handler: async (args, ctx) => {
    /**
     * G2 (spec §7.6.3) — A AUTORIZAÇÃO DEIXA DE SER ARGUMENTO.
     *
     * Aqui se montava uma lista de escopos e ela era passada ao recall como se
     * fosse filtro. Não era filtro: era a autorização inteira, escrita pelo
     * chamador. E a lista abria com `'global'`, o que devolvia memória de
     * escopo global para QUALQUER interlocutor, sem ninguém ter publicado
     * nada.
     *
     * Agora vai o PRINCIPAL, e quem decide o que ele pode ver é o predicado do
     * §7.6.3, dentro do SQL, antes de ordenar e limitar.
     *
     * As entidades do escopo saíram junto: memória é do TITULAR, e uma
     * entidade não é titular de dado pessoal. Projetar por entidade devolveria
     * a memória de uma pessoa a quem tem acesso à empresa dela.
     */
    const items = await recallAuthorized({
      principal: { pessoa_id: ctx.pessoa.id, conversa_id: ctx.conversa.id },
      query: args.query,
      tipos: args.tipos,
      k: args.k,
    });
    return {
      items: items.map((i) => ({ conteudo: i.content, tipo: i.memory_type, score: i.score })),
    };
  },
};
