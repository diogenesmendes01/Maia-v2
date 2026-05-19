/**
 * calendar_next_holiday — próximo feriado a partir de uma data (ou hoje).
 */
import { z } from 'zod';
import type { Tool } from '../_registry.js';
import { getNextHoliday } from '@/lib/business-days.js';

const inputSchema = z.object({
  from: z.string().optional().describe('Data inicial YYYY-MM-DD (default: hoje)'),
  entidade_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  holiday: z
    .object({
      date: z.string(),
      name: z.string(),
      type: z.string(),
    })
    .nullable(),
});

export const calendarNextHolidayTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'calendar_next_holiday',
  description:
    'Retorna o próximo feriado a partir de uma data (default hoje). Pode considerar feriados regionais quando entidade tem cidade/uf cadastrados.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'calendar_query',
  handler: async (args) => {
    const from = args.from ? new Date(`${args.from}T00:00:00Z`) : new Date();
    if (Number.isNaN(from.getTime())) throw new Error(`invalid from: ${args.from}`);
    const h = await getNextHoliday({ from, entidadeId: args.entidade_id });
    if (!h) return { holiday: null };
    return {
      holiday: {
        date: h.date.toISOString().slice(0, 10),
        name: h.name,
        type: h.type,
      },
    };
  },
};
