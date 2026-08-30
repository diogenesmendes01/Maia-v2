import { z } from 'zod';
import type { Tool } from './_registry.js';
import { audit } from '@/governance/audit.js';
import { pessoasRepo } from '@/db/repositories/pessoa-repos.js';
import { isValidIanaTimeZone } from '@/lib/timezone.js';

/**
 * `set_interlocutor_timezone` — persists the current interlocutor's IANA time
 * zone in `pessoas.preferencias.timezone`.
 *
 * WHY: the prompt's "Estado atual" renders *now* in the interlocutor's zone
 * (`resolveInterlocutorTz`), and `schedule_reminder` needs the LLM to build an
 * absolute ISO 8601 instant. Without a per-person zone the agent assumed the
 * platform default (`config.TZ`), so a user in another zone got reminders at the
 * wrong wall-clock time. This tool lets the agent record the zone the moment the
 * person reveals it ("estou em Portugal"), defaulting to `config.TZ` until then.
 *
 * Scope is FORCED to the caller's own pessoa (`ctx.pessoa.id`) — the tool never
 * accepts an arbitrary target, so it can only ever update the interlocutor it is
 * talking to (invariants #1 tenant isolation, #2 LLM proposes / backend
 * disposes: the backend forces the target and validates the IANA name; the LLM
 * only supplies the zone string). Gated by the `schedule_reminder` action so it
 * travels with the same agents that can schedule.
 */
const inputSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidIanaTimeZone, {
      message:
        'timezone precisa ser um nome IANA válido (ex.: America/Sao_Paulo, Europe/Lisbon)',
    }),
});

const outputSchema = z.object({
  pessoa_id: z.string(),
  timezone: z.string(),
});

export const setInterlocutorTimezoneTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'set_interlocutor_timezone',
  description:
    'Registra o fuso horário (nome IANA, ex.: America/Sao_Paulo, Europe/Lisbon) do interlocutor atual, para agendar lembretes e mostrar o horário no fuso correto dele. Use quando o usuário disser onde está ou qual o fuso dele.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['schedule_reminder'],
  side_effect: 'write',
  effect_class: 'idempotent',
  redis_required: false,
  operation_type: 'update_meta',
  audit_action: 'interlocutor_timezone_set',
  handler: async (args, ctx) => {
    // Read-modify-write the jsonb prefs (mirrors governance/audit-mode.ts):
    // merge only the `timezone` key, preserving any other preference.
    const prefs = {
      ...((ctx.pessoa.preferencias ?? {}) as Record<string, unknown>),
      timezone: args.timezone,
    };
    await pessoasRepo.updatePreferencias(ctx.pessoa.id, prefs);
    await audit({
      acao: 'interlocutor_timezone_set',
      pessoa_id: ctx.pessoa.id,
      conversa_id: ctx.conversa.id,
      mensagem_id: ctx.mensagem_id,
      alvo_id: ctx.pessoa.id,
      metadata: { timezone: args.timezone },
    });
    return { pessoa_id: ctx.pessoa.id, timezone: args.timezone };
  },
};
