import { z } from 'zod';
import type { Tool } from './_registry.js';
import { transacoesRepo, entidadesRepo, categoriasRepo, contasRepo } from '@/db/repositories.js';
import { generateExtratoPdf, type ExtratoTransaction } from '@/lib/pdf/extrato.js';
import { generateComparativoPdf, type ComparativoRow } from '@/lib/pdf/comparativo.js';
import { logger } from '@/lib/logger.js';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('extrato'),
    entidade_id: z.string().uuid(),
    date_from: z.string().regex(dateRegex),
    date_to: z.string().regex(dateRegex),
    natureza: z.enum(['receita', 'despesa', 'movimentacao']).optional(),
  }),
  z.object({
    tipo: z.literal('comparativo'),
    entidade_ids: z.array(z.string().uuid()).min(2).max(8),
    date_from: z.string().regex(dateRegex),
    date_to: z.string().regex(dateRegex),
  }),
]);

const outputSchema = z.union([
  z.object({
    path: z.string(),
    fileName: z.string(),
    mimetype: z.literal('application/pdf'),
    tipo: z.enum(['extrato', 'comparativo']),
    summary: z.object({
      period: z.string(),
      rowCount: z.number().int().nonnegative().optional(),
      totals: z
        .object({
          receita: z.number(),
          despesa: z.number(),
          lucro: z.number(),
        })
        .optional(),
    }),
  }),
  z.object({
    error: z.string(),
    message: z.string().optional(),
  }),
]);

export const generateReportTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'generate_report',
  description:
    'Gera um relatório financeiro em PDF e o envia como anexo no WhatsApp. Use quando o owner pedir "extrato", "relatório", "manda em PDF", "comparativo", ou quando a resposta seria uma tabela longa (>20 linhas). Caption do envio é o texto que você devolver depois do tool result. Não use para saldo (responder em texto direto).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  // Permission: extrato uses read_transactions; comparativo uses read_reports.
  // Dispatcher checks ALL required_actions, so listing both forces the LLM
  // to be authorized for either path. (Single-user Maia: owner has both.)
  required_actions: ['read_transactions', 'read_reports'],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'classification_suggested', // generic read action; the actual send is audited separately as `outbound_sent_document`
  sensitive: false, // per spec §11: no view-once for PDFs
  handler: async (args, ctx) => {
    if (args.tipo === 'extrato') {
      if (!ctx.scope.entidades.includes(args.entidade_id)) {
        return { error: 'forbidden', message: 'Entidade fora do escopo' };
      }
      const ent = await entidadesRepo.byId(args.entidade_id);
      if (!ent) return { error: 'forbidden', message: 'Entidade não encontrada' };

      const rawTxns = await transacoesRepo.byScope(
        { pessoa_id: ctx.pessoa.id, entidades: [args.entidade_id] },
        {
          date_from: args.date_from,
          date_to: args.date_to,
          natureza: args.natureza,
          limit: 600, // intentionally larger than the 500 hard limit so we KNOW we hit it
        },
      );

      // Resolve unique categoria names in one batch
      const catIds = Array.from(
        new Set(rawTxns.map((t) => t.categoria_id).filter((x): x is string => !!x)),
      );
      const catNameById = new Map<string, string>();
      for (const cid of catIds) {
        const cat = await categoriasRepo.byId(cid);
        if (cat) catNameById.set(cid, cat.nome);
      }

      const transactions: ExtratoTransaction[] = rawTxns.map((t) => ({
        data_competencia: t.data_competencia,
        natureza: t.natureza as 'receita' | 'despesa' | 'movimentacao',
        valor: Number(t.valor),
        descricao: t.descricao ?? '',
        categoriaNome: t.categoria_id ? catNameById.get(t.categoria_id) ?? null : null,
      }));

      try {
        const result = await generateExtratoPdf({
          ownerName: ctx.pessoa.nome,
          entidadeName: ent.nome,
          date_from: args.date_from,
          date_to: args.date_to,
          transactions,
        });
        return {
          path: result.path,
          fileName: result.fileName,
          mimetype: 'application/pdf' as const,
          tipo: 'extrato' as const,
          summary: result.summary,
        };
      } catch (err) {
        logger.error({ err }, 'generate_report.extrato_failed');
        return { error: 'pdf_generation_failed', message: (err as Error).message };
      }
    }

    // comparativo
    const allowedIds = args.entidade_ids.filter((id) => ctx.scope.entidades.includes(id));
    if (allowedIds.length === 0) {
      return { error: 'forbidden', message: 'Nenhuma das entidades está no escopo' };
    }
    if (allowedIds.length === 1) {
      return {
        error: 'comparativo_needs_two',
        message: 'Comparativo precisa de pelo menos 2 entidades acessíveis',
      };
    }

    const ents = await entidadesRepo.byIds(allowedIds);
    const entById = new Map(ents.map((e) => [e.id, e]));

    const rows: ComparativoRow[] = [];
    for (const id of allowedIds) {
      const ent = entById.get(id);
      if (!ent) continue;
      const txns = await transacoesRepo.byScope(
        { pessoa_id: ctx.pessoa.id, entidades: [id] },
        { date_from: args.date_from, date_to: args.date_to, limit: 5000 },
      );
      const receita = txns
        .filter((t) => t.natureza === 'receita')
        .reduce((s, t) => s + Number(t.valor), 0);
      const despesa = txns
        .filter((t) => t.natureza === 'despesa')
        .reduce((s, t) => s + Number(t.valor), 0);
      const contas = await contasRepo.byEntity(id);
      const caixa_final = contas.reduce((s, c) => s + Number(c.saldo_atual), 0);
      rows.push({
        entidade_id: id,
        entidade_nome: ent.nome,
        receita,
        despesa,
        lucro: receita - despesa,
        caixa_final,
      });
    }

    try {
      const result = await generateComparativoPdf({
        ownerName: ctx.pessoa.nome,
        date_from: args.date_from,
        date_to: args.date_to,
        rows,
      });
      return {
        path: result.path,
        fileName: result.fileName,
        mimetype: 'application/pdf' as const,
        tipo: 'comparativo' as const,
        summary: result.summary,
      };
    } catch (err) {
      logger.error({ err }, 'generate_report.comparativo_failed');
      return { error: 'pdf_generation_failed', message: (err as Error).message };
    }
  },
};
