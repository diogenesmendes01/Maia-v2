import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { workflowsRepo, workflowStepsRepo } from '@/db/repositories.js';
import { audit } from '@/governance/audit.js';
import type { Tool } from './_registry.js';
import { computeNext, parseRRule } from '@/workflows/rrule.js';

const stepSchema = z.object({
  ordem: z.number().int().positive(),
  descricao: z.string().min(1),
  tool: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
});

const outreachContextoSchema = z.object({
  rrule: z.string().min(1),
  destinatario_pessoa_id: z.string().uuid(),
  forward_to_pessoa_id: z.string().uuid().optional(),
  message_template: z.string().min(1).max(2000),
  forward_template: z.string().max(2000).optional(),
  wait_response_hours: z.number().int().positive().max(720).default(48),
  owner_pessoa_id: z.string().uuid(),
});

const paymentDueContextoSchema = z.object({
  rrule: z.string().min(1),
  conta_id: z.string().uuid(),
  natureza: z.literal('despesa').default('despesa'),
  valor: z.number().positive(),
  descricao: z.string().min(1).max(280),
  categoria_id: z.string().uuid().optional(),
  contraparte_id: z.string().uuid().optional(),
  escalate_after_hours: z.number().int().positive().max(168).default(4),
});

const inputSchema = z.object({
  tipo: z.enum([
    'fechamento_mes',
    'cobranca_balancete',
    'consolidacao_caixa',
    'follow_up',
    'outreach_recorrente',
    'payment_due',
  ]),
  entidade_id: z.string().uuid(),
  resumo: z.string().min(1),
  steps: z.array(stepSchema).min(0).max(20).default([]),
  contexto: z.record(z.unknown()).optional(),
  dual_approval_granted: z.boolean().optional(),
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

    // Type-specific contexto validation. The base inputSchema accepts a free
    // record so the LLM can pass arbitrary keys; we narrow here per `tipo`
    // and reject malformed shapes BEFORE persistence.
    let validatedContexto: Record<string, unknown>;
    let proxima_acao_em: Date = new Date();
    let chain_id: string | null = null;
    let stepsBlueprint: Array<{ ordem: number; descricao: string; resultado: Record<string, unknown> }> | null = null;

    if (args.tipo === 'outreach_recorrente') {
      const ctxParsed = outreachContextoSchema.safeParse(args.contexto ?? {});
      if (!ctxParsed.success) {
        throw new Error('outreach_recorrente: contexto inválido — ' + ctxParsed.error.message);
      }
      validatedContexto = { ...ctxParsed.data, resumo: args.resumo, requester_pessoa_id: ctx.pessoa.id };
      proxima_acao_em = computeNext(parseRRule(ctxParsed.data.rrule), new Date());
      chain_id = randomUUID();
      stepsBlueprint = [
        { ordem: 1, descricao: 'send_outreach', resultado: { type: 'send_outreach' } },
        { ordem: 2, descricao: 'await_response', resultado: { type: 'await_response' } },
        { ordem: 3, descricao: 'forward_or_close', resultado: { type: 'forward_or_close' } },
        { ordem: 4, descricao: 'reschedule', resultado: { type: 'reschedule' } },
      ];
    } else if (args.tipo === 'payment_due') {
      const ctxParsed = paymentDueContextoSchema.safeParse(args.contexto ?? {});
      if (!ctxParsed.success) {
        throw new Error('payment_due: contexto inválido — ' + ctxParsed.error.message);
      }
      validatedContexto = {
        ...ctxParsed.data,
        entidade_id: args.entidade_id,
        resumo: args.resumo,
        requester_pessoa_id: ctx.pessoa.id,
      };
      proxima_acao_em = computeNext(parseRRule(ctxParsed.data.rrule), new Date());
      chain_id = randomUUID();
      stepsBlueprint = [
        { ordem: 1, descricao: 'propose_payment', resultado: { type: 'propose_payment' } },
        { ordem: 2, descricao: 'await_owner_decision', resultado: { type: 'await_owner_decision' } },
        { ordem: 3, descricao: 'execute_or_skip', resultado: { type: 'execute_or_skip' } },
        { ordem: 4, descricao: 'reschedule', resultado: { type: 'reschedule' } },
      ];
    } else {
      validatedContexto = {
        ...(args.contexto ?? {}),
        resumo: args.resumo,
        requester_pessoa_id: ctx.pessoa.id,
      };
    }

    const wf = await workflowsRepo.create({
      tipo: args.tipo,
      status: 'pendente',
      contexto: validatedContexto,
      entidade_id: args.entidade_id,
      pessoa_envolvida: ctx.pessoa.id,
      proxima_acao_em,
      metadata: { idempotency_key: ctx.idempotency_key },
      chain_id,
    });

    const stepRows = stepsBlueprint
      ? stepsBlueprint.map((s) => ({
          workflow_id: wf.id,
          ordem: s.ordem,
          descricao: s.descricao,
          status: 'pendente' as const,
          resultado: s.resultado,
        }))
      : args.steps.map((s: z.infer<typeof stepSchema>) => ({
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
      metadata: { tipo: args.tipo, steps: created.length, chain_id },
    });
    return { workflow_id: wf.id, steps_count: created.length };
  },
};
