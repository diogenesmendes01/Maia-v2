import { z } from 'zod';
import type { Tool } from './_registry.js';
import { factsRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  entidade_id: z.string().uuid().optional(),
  quando: z.string(),
  texto: z.string().min(1).max(500),
  canal: z.enum(['whatsapp']).default('whatsapp'),
});

const outputSchema = z.object({
  reminder_id: z.string(),
  quando: z.string(),
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
    const id = 'rem-' + Math.random().toString(36).slice(2, 10);
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
    return { reminder_id: id, quando: args.quando };
  },
};
