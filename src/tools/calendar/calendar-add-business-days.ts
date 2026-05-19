/**
 * calendar_add_business_days — soma N dias úteis a uma data.
 */
import { z } from 'zod';
import type { Tool } from '../_registry.js';
import { addBusinessDays } from '@/lib/business-days.js';

const inputSchema = z.object({
  date: z.string().describe('Data base YYYY-MM-DD'),
  count: z.number().int().describe('Quantidade de dias úteis (positivo ou negativo)'),
  entidade_id: z.string().uuid().optional(),
  kind: z.enum(['standard', 'clt']).optional().default('standard'),
});

const outputSchema = z.object({
  result_date: z.string(),
});

export const calendarAddBusinessDaysTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'calendar_add_business_days',
  description:
    'Soma N dias úteis a uma data (N pode ser negativo para retroceder). Ex.: prazo D+5 para algum SLA.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'calendar_query',
  handler: async (args) => {
    const d = new Date(`${args.date}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${args.date}`);
    if (Math.abs(args.count) > 365 * 4) throw new Error('count out of bounds');
    const result = await addBusinessDays(d, args.count, {
      kind: args.kind ?? 'standard',
      entidadeId: args.entidade_id,
    });
    return { result_date: result.toISOString().slice(0, 10) };
  },
};
