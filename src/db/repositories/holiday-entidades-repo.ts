/**
 * holidayEntidadesRepo — junction CRUD com cross-tenant integrity pre-check.
 *
 * Invariante P0: nem holiday nem entidade podem ser de outro tenant que não o
 * atual. Pre-check explícito antes do INSERT — o REFERENCES sozinho não checa
 * tenant porque tenant_id é column denormalizada (não chave estrangeira).
 */
import { db } from '../client.js';
import { holidays, holiday_entidades, entidades } from '../schema.js';
import { getCurrentTenant } from '../tenant-context.js';
import { and, eq } from 'drizzle-orm';

export class CrossTenantIntegrityError extends Error {
  readonly code = 'CROSS_TENANT_INTEGRITY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'CrossTenantIntegrityError';
  }
}

export const holidayEntidadesRepo = {
  async link(args: { holiday_id: number; entidade_id: string }): Promise<void> {
    const tenant_id = getCurrentTenant();

    // CHECK 1: holiday pertence a este tenant
    const h = await db
      .select({ tid: holidays.tenant_id })
      .from(holidays)
      .where(eq(holidays.id, args.holiday_id))
      .limit(1);
    if (!h[0] || h[0].tid !== tenant_id) {
      throw new CrossTenantIntegrityError('cross-tenant integrity violation: holiday');
    }

    // CHECK 2: entidade pertence a este tenant
    const e = await db
      .select({ tid: entidades.tenant_id })
      .from(entidades)
      .where(eq(entidades.id, args.entidade_id))
      .limit(1);
    if (!e[0] || e[0].tid !== tenant_id) {
      throw new CrossTenantIntegrityError('cross-tenant integrity violation: entidade');
    }

    await db
      .insert(holiday_entidades)
      .values({
        tenant_id,
        holiday_id: args.holiday_id,
        entidade_id: args.entidade_id,
      })
      .onConflictDoNothing();
  },

  async unlink(args: { holiday_id: number; entidade_id: string }): Promise<void> {
    const tenant_id = getCurrentTenant();
    await db
      .delete(holiday_entidades)
      .where(
        and(
          eq(holiday_entidades.tenant_id, tenant_id),
          eq(holiday_entidades.holiday_id, args.holiday_id),
          eq(holiday_entidades.entidade_id, args.entidade_id),
        ),
      );
  },

  async listByEntidade(entidade_id: string): Promise<number[]> {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select({ holiday_id: holiday_entidades.holiday_id })
      .from(holiday_entidades)
      .where(
        and(
          eq(holiday_entidades.tenant_id, tenant_id),
          eq(holiday_entidades.entidade_id, entidade_id),
        ),
      );
    return rows.map((r) => r.holiday_id);
  },
};
