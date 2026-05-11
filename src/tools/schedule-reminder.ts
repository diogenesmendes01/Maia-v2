import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { factsRepo } from '@/db/repositories.js';

const PAST_GRACE_SECONDS = 60;
const FAR_FUTURE_THRESHOLD_DAYS = 365;

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  quando: z.string().refine(
    (s) => {
      const t = Date.parse(s);
      if (Number.isNaN(t)) return false;
      // Reject only if more than PAST_GRACE_SECONDS in the past. Clock skew
      // and "schedule for 5 min ago" UX edge cases handled by the grace.
      return t >= Date.now() - PAST_GRACE_SECONDS * 1000;
    },
    { message: 'quando precisa ser ISO 8601 futuro (ou no máximo 60s no passado)' },
  ),
  texto: z.string().min(1).max(500),
  canal: z.enum(['whatsapp']).default('whatsapp'),
});

const outputSchema = z.object({
  reminder_id: z.string(),
  quando: z.string(),
  warn_far_future: z.boolean().optional(),
});

export const scheduleReminderTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'schedule_reminder',
  description: 'Agenda um lembrete para enviar via WhatsApp em um momento futuro.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'reminder_scheduled',
  handler: async (args, ctx) => {
    const id = 'rem-' + randomUUID();
    const warn_far_future =
      Date.parse(args.quando) - Date.now() > FAR_FUTURE_THRESHOLD_DAYS * 86400 * 1000;
    await factsRepo.upsert({
      escopo: `pessoa:${ctx.pessoa.id}`,
      chave: `reminder.${id}`,
      valor: {
        id,
        pessoa_id: ctx.pessoa.id,
        entidade_id: args.entidade_id ?? null,
        quando: args.quando,
        texto: args.texto,
        canal: args.canal,
      },
      fonte: 'configurado',
    });
    return warn_far_future
      ? { reminder_id: id, quando: args.quando, warn_far_future: true }
      : { reminder_id: id, quando: args.quando };
  },
};
