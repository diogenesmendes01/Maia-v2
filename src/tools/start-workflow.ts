import { z } from 'zod';
import { workflowsRepo, workflowStepsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import type { Tool } from './_registry.js';

const stepSchema = z.object({
  ordem: z.number().int().positive(),
  descricao: z.string().min(1),
  tool: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
});

const inputSchema = z.object({
  tipo: z.enum(['fechamento_mes', 'cobranca_balancete', 'consolidacao_caixa', 'follow_up']),
  entidade_id: z.string().uuid(),
  resumo: z.string().min(1),
  steps: z.array(stepSchema).min(1).max(20),
  contexto: z.record(z.unknown()).optional(),
});

const outputSchema = z.object({
  workflow_id: z.string(),
  steps_count: z.number().int().nonnegative(),
});

/**
 * ReAct→Workflow hybrid bridge: when the model detects that a request needs
 * multiple steps over time (or across humans/days), it calls this tool to
 * persist a workflow + steps. The cron `tickEngine` then drives execution.
 */
export const startWorkflowTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'start_workflow',
  description:
    'Cria um workflow multi-passo persistido para tarefas que excedem o turn-by-turn (fechamento de mês, cobrança de balancete, consolidação, follow-up). Use quando a tarefa requer >2 passos sequenciais ou aguarda evento externo. NÃO use para ações simples (registrar transação, consultar saldo).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'reminder_scheduled',
  handler: async (args, ctx) => {
    if (!ctx.scope.entidades.includes(args.entidade_id)) {
      throw new Error('entidade fora do escopo');
    }
    const wf = await workflowsRepo.create({
      tipo: args.tipo,
      status: 'pendente',
      contexto: { ...(args.contexto ?? {}), resumo: args.resumo, requester_pessoa_id: ctx.pessoa.id },
      entidade_id: args.entidade_id,
      pessoa_envolvida: ctx.pessoa.id,
      proxima_acao_em: new Date(),
      metadata: { idempotency_key: ctx.idempotency_key },
    });
    const stepRows = args.steps.map((s: z.infer<typeof stepSchema>) => ({
      workflow_id: wf.id,
      ordem: s.ordem,
      descricao: s.descricao,
      status: 'pendente' as const,
      resultado: s.tool
        ? { tool: s.tool, args: s.args ?? {}, depends_on: s.depends_on ?? [] }
        : { depends_on: s.depends_on ?? [] },
    }));
    const created = await workflowStepsRepo.createMany(stepRows);
    await audit({
      acao: 'reminder_scheduled',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: wf.id,
      metadata: { tipo: args.tipo, steps: created.length },
    });
    return { workflow_id: wf.id, steps_count: created.length };
  },
};
