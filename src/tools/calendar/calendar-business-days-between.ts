/**
 * calendar_business_days_between — quantos dias úteis entre duas datas.
 */
import { z } from 'zod';
import type { Tool } from '../_registry.js';
import { isBusinessDayBR } from '@/lib/business-days.js';

const inputSchema = z.object({
  start: z.string().describe('Data inicial YYYY-MM-DD'),
  end: z.string().describe('Data final YYYY-MM-DD'),
  entidade_id: z.string().uuid().optional(),
  kind: z.enum(['standard', 'clt']).optional().default('standard'),
});

const outputSchema = z.object({
  business_days: z.number().int().nonnegative(),
  total_days: z.number().int().nonnegative(),
});

export const calendarBusinessDaysBetweenTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'calendar_business_days_between',
  description:
    'Conta quantos dias úteis há entre duas datas (inclusivos). Range limitado a 366 dias para evitar abuso.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'read',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'read',
  audit_action: 'calendar_query',
  handler: async (args) => {
    const start = new Date(`${args.start}T12:00:00Z`);
    const end = new Date(`${args.end}T12:00:00Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid start: ${args.start}`);
    if (Number.isNaN(end.getTime())) throw new Error(`invalid end: ${args.end}`);
    if (start > end) throw new Error('start must be <= end');
    const totalDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (totalDays > 366) throw new Error('range > 366 days not allowed');
    let bd = 0;
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      if (
        await isBusinessDayBR(d, {
          kind: args.kind ?? 'standard',
          entidadeId: args.entidade_id,
        })
      ) {
        bd++;
      }
    }
    return { business_days: bd, total_days: totalDays };
  },
};
