/**
 * Admin UI Setup — tenants router.
 *
 * Procedures:
 *   - list         — list every tenant (founder-only, cross-tenant by design)
 *   - getById      — fetch a single tenant (founder, or the user's own tenant)
 *   - create       — provision a new tenant (founder-only); appends audit
 *   - updateStatus — change tenant status active|suspended (founder-only);
 *                    appends audit
 *
 * Notes:
 *   - tenantsRepo methods don't use applyTenantGuard (tenants table is the
 *     anchor of the multi-tenant graph — it cannot be tenant-scoped itself).
 *   - admin_audit_log uses the SESSION tenant for tenant_id (so cross-tenant
 *     mutations by a founder show up in the founder's home-tenant audit feed).
 *     The target tenant id is preserved in change_summary.target_tenant_id
 *     for forensics.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, founderProcedure } from '../server.js';

// Tenant.id is a slug, not a UUID — keep it short, lowercase, kebab/snake.
const TenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters/digits/_/- and start with alnum');

const TenantStatusSchema = z.enum(['active', 'suspended']);

const CreateInputSchema = z.object({
  id: TenantIdSchema,
  nome: z.string().min(1).max(200),
  status: TenantStatusSchema.optional(),
});

const UpdateStatusInputSchema = z.object({
  id: TenantIdSchema,
  status: TenantStatusSchema,
  comment: z.string().min(10).max(1000),
});

const GetByIdInputSchema = z.object({ id: TenantIdSchema });

export const tenantsRouter = router({
  list: founderProcedure.query(async ({ ctx }) => {
    const items = await ctx.repos.tenantsRepo.list();
    return { items };
  }),

  getById: protectedProcedure.input(GetByIdInputSchema).query(async ({ input, ctx }) => {
    if (ctx.userRole !== 'founder' && input.id !== ctx.tenantId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cannot read another tenant',
      });
    }
    const tenant = await ctx.repos.tenantsRepo.findById(input.id);
    if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' });
    return tenant;
  }),

  create: founderProcedure.input(CreateInputSchema).mutation(async ({ input, ctx }) => {
    const existing = await ctx.repos.tenantsRepo.findById(input.id);
    if (existing) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Tenant '${input.id}' already exists`,
      });
    }

    const created = await ctx.repos.tenantsRepo.create({
      id: input.id,
      nome: input.nome,
      status: input.status ?? 'active',
    });

    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: ctx.tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'tenant_create',
      resource_type: 'tenant',
      resource_id: created.id,
      change_summary: {
        target_tenant_id: created.id,
        nome: created.nome,
        status: created.status,
      },
    });

    return created;
  }),

  updateStatus: founderProcedure
    .input(UpdateStatusInputSchema)
    .mutation(async ({ input, ctx }) => {
      const before = await ctx.repos.tenantsRepo.findById(input.id);
      if (!before) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' });
      }
      if (before.status === input.status) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Tenant is already ${input.status}`,
        });
      }

      const updated = await ctx.repos.tenantsRepo.updateStatus(input.id, input.status);
      if (!updated) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Update returned no row',
        });
      }

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'tenant_update_status',
        resource_type: 'tenant',
        resource_id: updated.id,
        change_summary: {
          target_tenant_id: updated.id,
          from_status: before.status,
          to_status: updated.status,
          reason: input.comment,
        },
      });

      return updated;
    }),
});
