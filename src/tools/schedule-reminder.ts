import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';
import { seriesRepo } from '@/scheduling/repos.js';
import { reminderTaskBlueprint } from '@/scheduling/engine.js';

const PAST_GRACE_SECONDS = 60;
const FAR_FUTURE_THRESHOLD_DAYS = 365;

// Issue #509 §6 — descriptions shipped to the model via the canonical JSON
// Schema. `quando` carries a `.refine()` (futuro), which has no JSON Schema
// keyword, so the constraint is stated in prose here AND still enforced by Zod
// in the dispatcher.
const inputSchema = z.object({
  entidade_id: z
    .string()
    .uuid()
    .optional()
    .describe('UUID opaco da entidade. Omita quando o lembrete não for de uma entidade específica.'),
  quando: z
    .string()
    .refine(
      (s) => {
        const t = Date.parse(s);
        if (Number.isNaN(t)) return false;
        return t >= Date.now() - PAST_GRACE_SECONDS * 1000;
      },
      { message: 'quando precisa ser ISO 8601 futuro (ou no máximo 60s no passado)' },
    )
    .describe(
      'Instante do disparo em ISO 8601 com offset, ex.: 2026-03-01T09:00:00-03:00. ' +
        'Deve ser futuro (tolerância de 60s no passado). Resolva expressões relativas ' +
        '("amanhã 9h") usando o fuso do interlocutor antes de chamar.',
    ),
  texto: z.string().min(1).max(500).describe('Texto do lembrete, 1 a 500 caracteres.'),
  canal: z
    .enum(['whatsapp'])
    .default('whatsapp')
    .describe('Canal de entrega. Omita para usar o default "whatsapp".'),
});

const outputSchema = z.object({
  series_id: z.string(),
  occurrence_id: z.string(),
  scheduled_for: z.string(),
  warn_far_future: z.boolean().optional(),
});

/**
 * Spec 18 §8.1 — creates a `one_shot_reminder` series and its single
 * occurrence in one transaction. The reminder fires via the outbox
 * worker; this tool never sends WhatsApp directly.
 */
export const scheduleReminderTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'schedule_reminder',
  description:
    'Agenda um lembrete único para enviar via WhatsApp em um momento futuro. Para lembretes recorrentes use start_recurring_outreach ou start_recurring_payment.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  // Issue #507 — a série criada é um efeito com relógio próprio (dispara sem
  // nós). Cancelar no meio deixa incerto se ela existe; `cancel_reminder` é a
  // compensação declarada.
  effect_class: 'compensatable',
  compensated_by: 'cancel_reminder',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'series_created',
  handler: async (args, ctx) => {
    const quandoDate = new Date(args.quando);
    const warn_far_future =
      quandoDate.getTime() - Date.now() > FAR_FUTURE_THRESHOLD_DAYS * 86400_000;
    const { series, occurrence } = await seriesRepo.createWithFirstOccurrence({
      tipo: 'one_shot_reminder',
      status: 'active',
      one_shot_at: quandoDate,
      rrule: null,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'skip_invalid_month',
      staleness_threshold_hours: 168, // a missed lembrete still useful up to a week late by default
      exclusive_per_destinatario: false,
      contexto_template: { texto: args.texto, canal: args.canal },
      entidade_id: args.entidade_id ?? null,
      owner_pessoa_id: ctx.pessoa.id,
      initial_occurrence: {
        scheduled_for: quandoDate,
        contexto_snapshot: { texto: args.texto, canal: args.canal },
        tasks: reminderTaskBlueprint(),
      },
    });
    await audit({
      acao: 'series_created',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: series.id,
      metadata: { tipo: 'one_shot_reminder' },
    });
    await audit({
      acao: 'occurrence_scheduled',
      pessoa_id: ctx.pessoa.id,
      alvo_id: occurrence.id,
      occurrence_id: occurrence.id,
      metadata: { series_id: series.id, scheduled_for: occurrence.scheduled_for.toISOString() },
    });
    return warn_far_future
      ? {
          series_id: series.id,
          occurrence_id: occurrence.id,
          scheduled_for: occurrence.scheduled_for.toISOString(),
          warn_far_future: true,
        }
      : {
          series_id: series.id,
          occurrence_id: occurrence.id,
          scheduled_for: occurrence.scheduled_for.toISOString(),
        };
  },
};
