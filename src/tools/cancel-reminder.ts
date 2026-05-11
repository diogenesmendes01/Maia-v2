import { z } from 'zod';
import type { Tool } from './_registry.js';
import { factsRepo } from '@/db/repositories.js';

const inputSchema = z.object({
  reminder_id: z.string().min(1),
});

const outputSchema = z.object({
  cancelled: z.boolean(),
  reason: z.enum(['not_found', 'already_fired', 'already_cancelled']).optional(),
});

/**
 * Cancels a previously scheduled reminder by marking the underlying
 * agent_facts row inert. The firer skips any row where `fired_at` is set, so
 * setting `fired_at = now()` plus `cancel_reason = 'owner_request'` is
 * idempotent and won't double-fire if a tick races with the cancel.
 */
export const cancelReminderTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'cancel_reminder',
  description:
    'Cancela um lembrete antes que ele dispare. Use quando o usuário pedir para esquecer/cancelar algo que já foi agendado.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'reminder_cancelled',
  handler: async (args, ctx) => {
    const escopo = `pessoa:${ctx.pessoa.id}`;
    const chave = `reminder.${args.reminder_id}`;
    const existing = await factsRepo.getByKey(escopo, chave);
    if (!existing) return { cancelled: false, reason: 'not_found' as const };
    const valor = existing.valor as Record<string, unknown>;
    if (typeof valor.fired_at === 'string' && valor.fired_at.length > 0) {
      const wasCancelled = valor.cancel_reason === 'owner_request';
      return {
        cancelled: false,
        reason: wasCancelled ? ('already_cancelled' as const) : ('already_fired' as const),
      };
    }
    await factsRepo.upsert({
      escopo,
      chave,
      valor: { ...valor, fired_at: new Date().toISOString(), cancel_reason: 'owner_request' },
      fonte: (existing.fonte as 'configurado' | 'aprendido' | 'inferido') ?? 'configurado',
    });
    return { cancelled: true };
  },
};
