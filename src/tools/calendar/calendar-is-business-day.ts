/**
 * calendar_is_business_day — read-only. Retorna se a data é dia útil para o
 * contexto (entidade opcional). Honra FEATURE_CALENDAR_V2 (flag OFF = fallback
 * só-nacionais hard-coded; ainda funcional).
 */
import { z } from 'zod';
import type { Tool } from '../_registry.js';
import { isBusinessDayBR } from '@/lib/business-days.js';
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

const inputSchema = z.object({
  date: z.string().describe('Data no formato YYYY-MM-DD'),
  entidade_id: z.string().uuid().optional(),
  kind: z.enum(['standard', 'clt']).optional().default('standard'),
});

const outputSchema = z.object({
  date: z.string(),
  is_business_day: z.boolean(),
  calendar_v2_enabled: z.boolean(),
});

export const calendarIsBusinessDayTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'calendar_is_business_day',
  description:
    'Verifica se uma data é dia útil no Brasil. Considera feriados nacionais, estaduais e municipais quando a entidade tem cidade/uf cadastrados.',
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
    const ok = await isBusinessDayBR(d, {
      kind: args.kind ?? 'standard',
      entidadeId: args.entidade_id,
    });
    return {
      date: args.date,
      is_business_day: ok,
      calendar_v2_enabled: featureFlags.isEnabled(FeatureFlagName.CALENDAR_V2),
    };
  },
};
