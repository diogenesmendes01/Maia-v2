/**
 * register_custom_holiday — owner cria feriado entity_custom (vinculado a uma
 * ou mais entidades) ou holding_recess (recesso de grupo). Direto (sem pipeline
 * de aprovação) porque vem do owner. Invalida cache.
 *
 * Codex review #105 (high): autoriza CADA entidade_id em `ctx.scope.entidades`
 * com `manage_calendar` antes de qualquer write. O dispatcher só checa um
 * `entidade_id` singular (ou o primeiro do scope); aqui o tool aceita array,
 * então a checagem por elemento precisa rodar dentro do handler.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { holidaysRepo } from '@/db/repositories/holidays-repo.js';
import { holidayEntidadesRepo } from '@/db/repositories/holiday-entidades-repo.js';
import { invalidateCacheForHolidayChange } from '@/lib/holidays-cache.js';
import { getCurrentTenant } from '@/db/tenant-context.js';
import { canAct } from '@/governance/permissions.js';
import { FeatureFlagName } from '@/types/enums.js';

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
  feature_flag: FeatureFlagName.CALENDAR_V2,
  handler: async (args, ctx) => {
    const tenant_id = getCurrentTenant();

    // Codex review #105 (high): autoriza CADA entidade_id contra ctx.scope.
    // Sem isso, caller com manage_calendar em uma entidade pode vincular
    // holiday a qualquer entidade do mesmo tenant que conheça por UUID.
    // Dedup defensivo para não duplicar work nem linked count.
    const uniqueIds = Array.from(new Set(args.entidade_ids));
    for (const eid of uniqueIds) {
      if (!ctx.scope.entidades.includes(eid)) {
        throw new Error(`entidade fora do escopo: ${eid}`);
      }
      const resolved = ctx.scope.byEntity.get(eid);
      const allow = canAct({
        pessoa: ctx.pessoa,
        resolved: resolved ?? null,
        action: 'manage_calendar',
      });
      if (!allow.allowed) {
        throw new Error(`sem permissão manage_calendar em ${eid}: ${allow.reason}`);
      }
    }

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
    for (const eid of uniqueIds) {
      await holidayEntidadesRepo.link({ holiday_id: created.id, entidade_id: eid });
      linked++;
    }
    invalidateCacheForHolidayChange(
      { tenant_id, type: args.type, entidade_ids: uniqueIds },
      { changeKind: 'create' },
    );
    return { holiday_id: created.id, linked_entidades: linked };
  },
};
