import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';
import { seriesRepo } from '@/scheduling/repos.js';
import { computeNext, parseRRule } from '@/scheduling/rrule.js';
import { outreachTaskBlueprint } from '@/scheduling/engine.js';
import { newCorrelationToken } from '@/scheduling/correlation.js';

const inputSchema = z.object({
  rrule: z.string().min(1),
  destinatario_pessoa_id: z.string().uuid(),
  forward_to_pessoa_id: z.string().uuid().optional(),
  message_template: z.string().min(1).max(2000),
  forward_template: z.string().max(2000).optional(),
  wait_response_hours: z.number().int().min(1).max(720).default(48),
  month_end_policy: z
    .enum(['skip_invalid_month', 'last_day_of_month', 'nearest_previous', 'nearest_next'])
    .default('skip_invalid_month'),
  missed_run_policy: z
    .enum(['fire_all', 'fire_latest_only', 'skip_all', 'escalate_to_owner'])
    .default('escalate_to_owner'),
  staleness_threshold_hours: z.number().int().min(1).max(720).default(24),
  exclusive_per_destinatario: z.boolean().default(false),
  entidade_id: z.string().uuid(),
  dual_approval_granted: z.boolean(),
});

const outputSchema = z.object({
  series_id: z.string(),
  next_occurrence_id: z.string(),
  next_scheduled_for: z.string(),
});

/**
 * Spec 18 §8.3 — creates a `recurring_outreach` series + the next
 * scheduled occurrence in one transaction. Each subsequent cycle is
 * scheduled at the end of the previous occurrence's execution.
 *
 * Constitutional gate C-007 (rules.ts) requires `dual_approval_granted`.
 */
export const startRecurringOutreachTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'start_recurring_outreach',
  description:
    'Agenda uma série recorrente de mensagens para um terceiro (ex: pedir relatório mensal). Cada ciclo envia o template para o destinatário, espera resposta (ou expira em wait_response_hours), e se forward_template estiver setado, encaminha para uma segunda pessoa. Requer aprovação dupla (dual_approval_granted=true).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['send_proactive_message'],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'series_created',
  handler: async (args, ctx) => {
    if (!ctx.scope.entidades.includes(args.entidade_id)) {
      throw new Error('entidade fora do escopo');
    }
    const first_scheduled_for = computeNext(
      parseRRule(args.rrule),
      new Date(),
      args.month_end_policy,
    );
    const correlation_token = newCorrelationToken();
    const contexto = {
      destinatario_pessoa_id: args.destinatario_pessoa_id,
      forward_to_pessoa_id: args.forward_to_pessoa_id ?? null,
      message_template: args.message_template,
      forward_template: args.forward_template ?? null,
      wait_response_hours: args.wait_response_hours,
    };
    const { series, occurrence } = await seriesRepo.createWithFirstOccurrence({
      tipo: 'recurring_outreach',
      status: 'active',
      rrule: args.rrule,
      one_shot_at: null,
      month_end_policy: args.month_end_policy,
      missed_run_policy: args.missed_run_policy,
      staleness_threshold_hours: args.staleness_threshold_hours,
      exclusive_per_destinatario: args.exclusive_per_destinatario,
      contexto_template: contexto,
      entidade_id: args.entidade_id,
      owner_pessoa_id: ctx.pessoa.id,
      initial_occurrence: {
        scheduled_for: first_scheduled_for,
        contexto_snapshot: contexto,
        correlation_token,
        tasks: outreachTaskBlueprint(),
      },
    });
    await audit({
      acao: 'series_created',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: series.id,
      metadata: { tipo: 'recurring_outreach', destinatario: args.destinatario_pessoa_id },
    });
    await audit({
      acao: 'occurrence_scheduled',
      pessoa_id: ctx.pessoa.id,
      alvo_id: occurrence.id,
      occurrence_id: occurrence.id,
      metadata: { series_id: series.id, scheduled_for: occurrence.scheduled_for.toISOString() },
    });
    return {
      series_id: series.id,
      next_occurrence_id: occurrence.id,
      next_scheduled_for: occurrence.scheduled_for.toISOString(),
    };
  },
};
