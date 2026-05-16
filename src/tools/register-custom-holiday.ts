/**
 * register_custom_holiday — owner cria feriado entity_custom (vinculado a uma
 * ou mais entidades) ou holding_recess (recesso de grupo). Direto (sem pipeline
 * de aprovação) porque vem do owner. Invalida cache.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { holidaysRepo } from '@/db/repositories/holidays-repo.js';
import { holidayEntidadesRepo } from '@/db/repositories/holiday-entidades-repo.js';
import { invalidateCacheForHolidayChange } from '@/lib/holidays-cache.js';
import { getCurrentTenant } from '@/db/tenant-context.js';

const inputSchema = z.object({
  name: z.string().min(1).max(120),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  year: z.number().int().min(2020).max(2100).optional(),
  type: z.enum(['entity_custom', 'holding_recess']).default('entity_custom'),
  entidade_ids: z.array(z.string().uuid()).min(1).max(50),
});

const outputSchema = z.object({
  holiday_id: z.number(),
  linked_entidades: z.number().int().nonnegative(),
});

export const registerCustomHolidayTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'register_custom_holiday',
  description:
    'Registra um feriado custom (entity_custom) ou recesso de holding (holding_recess) vinculado a uma ou mais entidades.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['manage_calendar'],
  side_effect: 'write',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'manage_calendar',
  handler: async (args) => {
    const tenant_id = getCurrentTenant();
    const created = await holidaysRepo.create({
      name: args.name,
      month: args.month,
      day: args.day,
      year: args.year,
      type: args.type,
      status: 'ativo',
      source: 'owner',
    });
    let linked = 0;
    for (const eid of args.entidade_ids) {
      await holidayEntidadesRepo.link({ holiday_id: created.id, entidade_id: eid });
      linked++;
    }
    invalidateCacheForHolidayChange(
      { tenant_id, type: args.type, entidade_ids: args.entidade_ids },
      { changeKind: 'create' },
    );
    return { holiday_id: created.id, linked_entidades: linked };
  },
};
