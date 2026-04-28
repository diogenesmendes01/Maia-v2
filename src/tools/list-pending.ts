import { z } from 'zod';
import { db } from '@/db/client.js';
import { pending_questions, workflows, transacoes } from '@/db/schema.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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

    const pq = await db
      .select()
      .from(pending_questions)
      .where(and(eq(pending_questions.pessoa_id, ctx.pessoa.id), eq(pending_questions.status, 'aberta')))
      .orderBy(desc(pending_questions.created_at))
      .limit(limit);
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

    const wfs = await db
      .select()
      .from(workflows)
      .where(
        and(
          inArray(workflows.entidade_id, ents),
          sql`status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')`,
        ),
      )
      .orderBy(desc(workflows.iniciado_em))
      .limit(limit);
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

    const tx = await db
      .select()
      .from(transacoes)
      .where(
        and(
          inArray(transacoes.entidade_id, ents),
          eq(transacoes.status, 'pendente'),
          isNull(transacoes.confirmada_em),
        ),
      )
      .orderBy(desc(transacoes.data_competencia))
      .limit(limit);
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
