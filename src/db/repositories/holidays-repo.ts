/**
 * holidaysRepo — CRUD + findApplicable/findInRange para a tabela holidays.
 *
 * tenant_guard: toda query passa por applyTenantGuard (P0 invariant). Função
 * applicabilidade considera type:
 *   - national: aplica a todo tenant
 *   - state: aplica se uf da entidade bate
 *   - municipal: aplica se uf+cidade da entidade batem
 *   - entity_custom / holding_recess: aplica via junction holiday_entidades
 */
import { db } from '../client.js';
import { holidays, holiday_entidades, entidades } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant } from '../tenant-context.js';
import { and, eq, sql, or, isNull, inArray } from 'drizzle-orm';
import type { Holiday } from '../schema.js';

export type HolidayType =
  | 'national'
  | 'state'
  | 'municipal'
  | 'entity_custom'
  | 'holding_recess';

export const holidaysRepo = {
  /**
   * findApplicable — feriados aplicáveis na data dada para opcionalmente uma
   * entidade. Considera year=NULL (recorrente) + year=<this> + regionalidade.
   */
  async findApplicable(args: { entidadeId?: string; date: Date }): Promise<Holiday[]> {
    const tenant_id = getCurrentTenant();
    const month = args.date.getUTCMonth() + 1;
    const day = args.date.getUTCDate();
    const year = args.date.getUTCFullYear();

    const monthDayConds = [
      eq(holidays.status, 'ativo'),
      eq(holidays.tenant_id, tenant_id),
      eq(holidays.month, month),
      eq(holidays.day, day),
      or(isNull(holidays.year), eq(holidays.year, year))!,
    ];

    if (!args.entidadeId) {
      // Sem entidade → só nacionais.
      const rows = await db
        .select()
        .from(holidays)
        .where(and(...monthDayConds, eq(holidays.type, 'national')));
      return rows;
    }

    // Com entidade → nacional + state(uf bate) + municipal(uf+cidade) + entity_custom via junction.
    const ent = await db
      .select({ uf: entidades.uf, cidade: entidades.cidade })
      .from(entidades)
      .where(and(eq(entidades.id, args.entidadeId), eq(entidades.tenant_id, tenant_id)))
      .limit(1);
    const uf = ent[0]?.uf ?? null;
    const cidade = ent[0]?.cidade ?? null;

    // Custom IDs via junction
    const customRows = await db
      .select({ holiday_id: holiday_entidades.holiday_id })
      .from(holiday_entidades)
      .where(
        and(
          eq(holiday_entidades.tenant_id, tenant_id),
          eq(holiday_entidades.entidade_id, args.entidadeId),
        ),
      );
    const customIds = customRows.map((r) => r.holiday_id);

    const typeFilter = or(
      eq(holidays.type, 'national'),
      uf ? and(eq(holidays.type, 'state'), eq(holidays.uf, uf))! : sql`false`,
      uf && cidade
        ? and(
            eq(holidays.type, 'municipal'),
            eq(holidays.uf, uf),
            eq(holidays.cidade, cidade),
          )!
        : sql`false`,
      customIds.length > 0 ? inArray(holidays.id, customIds) : sql`false`,
    );

    return await db
      .select()
      .from(holidays)
      .where(and(...monthDayConds, typeFilter));
  },

  /**
   * findInRange — feriados aplicáveis num range (mesmo ano). Caller do cache
   * passa Jan-Dez, então tabela retornada é pequena. Filtra month/day no app.
   */
  async findInRange(args: {
    entidadeId?: string;
    start: Date;
    end: Date;
  }): Promise<Holiday[]> {
    const tenant_id = getCurrentTenant();
    const year = args.start.getUTCFullYear();

    const baseConds = [
      eq(holidays.status, 'ativo'),
      eq(holidays.tenant_id, tenant_id),
      or(isNull(holidays.year), eq(holidays.year, year))!,
    ];

    let typeFilter;
    if (!args.entidadeId) {
      typeFilter = eq(holidays.type, 'national');
    } else {
      const ent = await db
        .select({ uf: entidades.uf, cidade: entidades.cidade })
        .from(entidades)
        .where(and(eq(entidades.id, args.entidadeId), eq(entidades.tenant_id, tenant_id)))
        .limit(1);
      const uf = ent[0]?.uf ?? null;
      const cidade = ent[0]?.cidade ?? null;

      const customRows = await db
        .select({ holiday_id: holiday_entidades.holiday_id })
        .from(holiday_entidades)
        .where(
          and(
            eq(holiday_entidades.tenant_id, tenant_id),
            eq(holiday_entidades.entidade_id, args.entidadeId),
          ),
        );
      const customIds = customRows.map((r) => r.holiday_id);

      typeFilter = or(
        eq(holidays.type, 'national'),
        uf ? and(eq(holidays.type, 'state'), eq(holidays.uf, uf))! : sql`false`,
        uf && cidade
          ? and(
              eq(holidays.type, 'municipal'),
              eq(holidays.uf, uf),
              eq(holidays.cidade, cidade),
            )!
          : sql`false`,
        customIds.length > 0 ? inArray(holidays.id, customIds) : sql`false`,
      );
    }

    const all = await db
      .select()
      .from(holidays)
      .where(and(...baseConds, typeFilter));

    const startMonth = args.start.getUTCMonth() + 1;
    const startDay = args.start.getUTCDate();
    const endMonth = args.end.getUTCMonth() + 1;
    const endDay = args.end.getUTCDate();
    const startMD = startMonth * 100 + startDay;
    const endMD = endMonth * 100 + endDay;
    return all.filter((h) => {
      const monthDay = h.month * 100 + h.day;
      return startMD <= monthDay && monthDay <= endMD;
    });
  },

  async create(args: {
    name: string;
    month: number;
    day: number;
    year?: number;
    type: HolidayType;
    uf?: string;
    cidade?: string;
    proposal_id?: string;
    status?: 'ativo' | 'rejeitado' | 'pending';
    source?: string;
    approved_by?: string;
  }): Promise<Holiday> {
    const guarded = applyTenantGuard({
      name: args.name,
      month: args.month,
      day: args.day,
      year: args.year ?? null,
      type: args.type,
      uf: args.uf ?? null,
      cidade: args.cidade ?? null,
      proposal_id: args.proposal_id ?? null,
      status: args.status ?? 'ativo',
      source: args.source ?? null,
      approved_by: args.approved_by ?? null,
      approved_at: args.status === 'ativo' ? new Date() : null,
    });
    // applyTenantGuard adds agent_id, but holidays don't have agent_id — strip it.
    const { agent_id: _, ...row } = guarded as Record<string, unknown> & { agent_id?: string };
    const inserted = await db
      .insert(holidays)
      .values(row as typeof holidays.$inferInsert)
      .returning();
    return inserted[0]!;
  },

  async updateStatus(args: {
    id: number;
    status: 'ativo' | 'rejeitado' | 'pending';
    approved_by?: string;
  }): Promise<void> {
    const tenant_id = getCurrentTenant();
    await db
      .update(holidays)
      .set({
        status: args.status,
        approved_by: args.approved_by ?? null,
        approved_at: args.status === 'ativo' ? new Date() : null,
      })
      .where(and(eq(holidays.id, args.id), eq(holidays.tenant_id, tenant_id)));
  },

  async findByProposalId(proposal_id: string): Promise<Holiday | null> {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select()
      .from(holidays)
      .where(and(eq(holidays.proposal_id, proposal_id), eq(holidays.tenant_id, tenant_id)))
      .limit(1);
    return rows[0] ?? null;
  },
};
