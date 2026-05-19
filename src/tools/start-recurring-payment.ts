import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';
import { seriesRepo } from '@/scheduling/repos.js';
import { computeNext, parseRRule } from '@/scheduling/rrule.js';
import {
  parseRRule as parseRRuleExtended,
  usesBusinessDayExtension,
  computeNextWithBusinessDays,
} from '@/scheduling/business-day-rrule.js';
import { paymentTaskBlueprint } from '@/scheduling/engine.js';

const inputSchema = z.object({
  rrule: z.string().min(1),
  conta_id: z.string().uuid(),
  valor: z.number().positive(),
  descricao: z.string().min(1).max(280),
  categoria_id: z.string().uuid().optional(),
  contraparte_id: z.string().uuid().optional(),
  escalate_after_hours: z.number().int().min(1).max(168).default(4),
  month_end_policy: z
    .enum(['skip_invalid_month', 'last_day_of_month', 'nearest_previous', 'nearest_next'])
    .default('last_day_of_month'),
  missed_run_policy: z
    .enum(['fire_all', 'fire_latest_only', 'skip_all', 'escalate_to_owner'])
    .default('fire_latest_only'),
  staleness_threshold_hours: z.number().int().min(1).max(720).default(24),
  entidade_id: z.string().uuid(),
});

const outputSchema = z.object({
  series_id: z.string(),
  next_occurrence_id: z.string(),
  next_scheduled_for: z.string(),
});

/**
 * Spec 18 §8.4 — creates a `recurring_payment` series. The series itself
 * NEVER moves money; each occurrence fires a `pending_question` to the
 * owner and waits for sim/nao/adiar. The transaction is dispatched
 * through the normal tool pipeline only when the owner confirms.
 *
 * Constitutional gate C-006 (rules.ts) rejects valor > VALOR_LIMITE_DURO.
 */
export const startRecurringPaymentTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'start_recurring_payment',
  description:
    'Agenda uma série recorrente de confirmações de pagamento. A Maia NUNCA paga sozinha — em cada ciclo ela pergunta ao dono se deve pagar (sim/não/adiar), e só com "sim" registra a transação. Use para aluguel mensal, conta fixa, mensalidade etc.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_transaction'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'series_created',
  handler: async (args, ctx) => {
    if (!ctx.scope.entidades.includes(args.entidade_id)) {
      throw new Error('entidade fora do escopo');
    }
    // Codex review #105 (medium): detecta extensão business-day (BYNTHWORKDAY
    // ou BYWORKDAY=true) e roteia para o parser/engine async correspondente.
    // Sem isso, regras como "5° dia útil do mês" (BYNTHWORKDAY=5) ou "DAILY
    // pulando feriados" (BYWORKDAY=true) seriam rejeitadas pelo parser
    // legacy e a extensão fica inalcançável pelo product path.
    const extParsed = parseRRuleExtended(args.rrule);
    const first_scheduled_for = usesBusinessDayExtension(extParsed)
      ? await computeNextWithBusinessDays(extParsed, new Date(), {
          monthEndPolicy: args.month_end_policy,
          entidadeId: args.entidade_id,
        })
      : computeNext(parseRRule(args.rrule), new Date(), args.month_end_policy);
    const contexto = {
      conta_id: args.conta_id,
      valor: args.valor,
      descricao: args.descricao,
      categoria_id: args.categoria_id ?? null,
      contraparte_id: args.contraparte_id ?? null,
      escalate_after_hours: args.escalate_after_hours,
    };
    const { series, occurrence } = await seriesRepo.createWithFirstOccurrence({
      tipo: 'recurring_payment',
      status: 'active',
      rrule: args.rrule,
      one_shot_at: null,
      month_end_policy: args.month_end_policy,
      missed_run_policy: args.missed_run_policy,
      staleness_threshold_hours: args.staleness_threshold_hours,
      exclusive_per_destinatario: false,
      contexto_template: contexto,
      entidade_id: args.entidade_id,
      owner_pessoa_id: ctx.pessoa.id,
      initial_occurrence: {
        scheduled_for: first_scheduled_for,
        contexto_snapshot: contexto,
        tasks: paymentTaskBlueprint(),
      },
    });
    await audit({
      acao: 'series_created',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: series.id,
      metadata: { tipo: 'recurring_payment', valor: args.valor },
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
