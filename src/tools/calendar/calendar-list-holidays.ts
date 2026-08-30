/**
 * calendar_list_holidays — lista feriados num intervalo (ano, mês, range).
 */
import { z } from 'zod';
import type { Tool } from '../_registry.js';
import { getHolidaysInRange } from '@/lib/business-days.js';

const inputSchema = z.object({
  start: z.string().describe('Data inicial YYYY-MM-DD'),
  end: z.string().describe('Data final YYYY-MM-DD'),
  entidade_id: z.string().uuid().optional(),
});

const outputSchema = z.object({
  holidays: z.array(
    z.object({
      date: z.string(),
      name: z.string(),
      type: z.string(),
    }),
  ),
});

export const calendarListHolidaysTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'calendar_list_holidays',
  description:
    'Lista feriados num intervalo de datas. Considera regionais (estaduais + municipais) quando entidade tem cidade/uf cadastrados.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'calendar_query',
  handler: async (args) => {
    const start = new Date(`${args.start}T00:00:00Z`);
    const end = new Date(`${args.end}T23:59:59Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid start: ${args.start}`);
    if (Number.isNaN(end.getTime())) throw new Error(`invalid end: ${args.end}`);
    if (start > end) throw new Error('start must be <= end');
    const list = await getHolidaysInRange({ start, end, entidadeId: args.entidade_id });
    return {
      holidays: list.map((h) => ({
        date: h.date.toISOString().slice(0, 10),
        name: h.name,
        type: h.type,
      })),
    };
  },
};
