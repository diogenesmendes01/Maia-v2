import { z } from 'zod';
import { pendingQuestionsRepo, workflowsRepo, transacoesRepo } from '@/db/repositories.js';
import type { Tool } from './_registry.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const itemSchema = z.object({
  kind: z.enum(['pergunta', 'workflow', 'transacao_pendente', 'aprovacao_4_eyes']),
  id: z.string(),
  resumo: z.string(),
  desde: z.string().nullable(),
  expira_em: z.string().nullable(),
  entidade_id: z.string().nullable(),
});

const outputSchema = z.object({
  itens: z.array(itemSchema),
  total: z.number().int().nonnegative(),
});

export const listPendingTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'list_pending',
  description:
    'Lista o que está pendente para o interlocutor: perguntas abertas, workflows em andamento, aprovações 4-olhos aguardando, e transações com status pendente. Use quando o usuário pergunta "o que tá pendente", "tem algo aberto?", etc.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['read_pending_questions'],
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested',
  handler: async (args, ctx) => {
    const limit = args.limit ?? 20;
    const ents = args.entidade_id
      ? ctx.scope.entidades.includes(args.entidade_id)
        ? [args.entidade_id]
        : []
      : ctx.scope.entidades;
    if (ents.length === 0) return { itens: [], total: 0 };

    const itens: z.infer<typeof itemSchema>[] = [];

    // Issue #363: all three reads MUST be tenant+agent scoped — this tool is
    // registered for the LLM tool registry and its result (q.pergunta, workflow
    // intent, transação descrições) is injected back into the prompt context.
    // pessoa_id/entidade_id are GLOBAL uuids, so filtering by them alone (the
    // prior inline `db.select`) did NOT scope by tenant. The repo methods bind
    // tenant_id+agent_id from ALS (the handler runs inside the agent turn's
    // runWithTenantContext), so a foreign tenant's pending content can never
    // contaminate this Maia's context. (R2 LLM-context-contamination, cf. #357.)
    const pq = await pendingQuestionsRepo.listOpenForPessoa(ctx.pessoa.id, limit);
    for (const q of pq) {
      itens.push({
        kind: 'pergunta',
        id: q.id,
        resumo: q.pergunta,
        desde: q.created_at?.toISOString() ?? null,
        expira_em: q.expira_em?.toISOString() ?? null,
        entidade_id: null,
      });
    }

    const wfs = await workflowsRepo.listPendingForEntidades(ents, limit);
    for (const w of wfs) {
      const ctxObj = (w.contexto ?? {}) as Record<string, unknown>;
      const tool = (ctxObj.intent as { tool?: string } | undefined)?.tool;
      itens.push({
        kind: w.tipo === 'dual_approval' ? 'aprovacao_4_eyes' : 'workflow',
        id: w.id,
        resumo: tool ? `${w.tipo}: ${tool}` : w.tipo,
        desde: w.iniciado_em?.toISOString() ?? null,
        expira_em: w.proxima_acao_em?.toISOString() ?? null,
        entidade_id: w.entidade_id,
      });
    }

    const tx = await transacoesRepo.listPendingForEntidades(ents, limit);
    for (const t of tx) {
      itens.push({
        kind: 'transacao_pendente',
        id: t.id,
        resumo: `${t.natureza} ${t.descricao} R$ ${t.valor}`,
        desde: t.created_at?.toISOString() ?? null,
        expira_em: null,
        entidade_id: t.entidade_id,
      });
    }

    return { itens: itens.slice(0, limit), total: itens.length };
  },
};
