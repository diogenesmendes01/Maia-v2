import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';
import { seriesRepo } from '@/scheduling/repos.js';

const inputSchema = z.object({
  series_id: z.string().uuid(),
  reason: z.string().max(280).optional(),
});

const outputSchema = z.object({
  cancelled: z.boolean(),
  cancelled_occurrence_count: z.number().int().nonnegative(),
  reason: z.enum(['not_found', 'already_cancelled']).optional(),
});

/**
 * Spec 18 §8.2 — atomically cancel an entire series (and its pending /
 * claimed occurrences). The repo runs the cancel as one transaction
 * with `WHERE status='active'` and a version bump, so a racing engine
 * tick that's about to insert the next occurrence finds the series
 * in the wrong version and drops the insert.
 *
 * Replaces both the old `cancel_reminder` (which acted on agent_facts)
 * and `cancel_workflow` (which acted on the workflows table).
 */
export const cancelReminderTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'cancel_reminder',
  description:
    'Cancela uma série agendada (lembrete único, outreach recorrente, payment_due). Encerra a série e todas as ocorrências pendentes/em execução numa transação só. Use quando o usuário pede para esquecer/cancelar algo agendado.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  effect_class: 'idempotent',
  redis_required: false,
  operation_type: 'cancel',
  audit_action: 'series_cancelled',
  handler: async (args, ctx) => {
    const result = await seriesRepo.cancelAtomic(args.series_id, ctx.pessoa.id);
    if (!result.series) {
      return { cancelled: false, cancelled_occurrence_count: 0, reason: 'not_found' };
    }
    if (result.series.status === 'cancelled' && result.cancelled_occurrence_ids.length === 0) {
      return { cancelled: false, cancelled_occurrence_count: 0, reason: 'already_cancelled' };
    }
    await audit({
      acao: 'series_cancelled',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: result.series.id,
      metadata: {
        reason: args.reason ?? null,
        cancelled_occurrences: result.cancelled_occurrence_ids,
      },
    });
    return {
      cancelled: true,
      cancelled_occurrence_count: result.cancelled_occurrence_ids.length,
    };
  },
};
