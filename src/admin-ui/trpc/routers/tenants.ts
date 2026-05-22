/**
 * Admin UI Setup — tenants router.
 *
 * Procedures:
 *   - list         — list every tenant (founder-only, cross-tenant by design)
 *   - getById      — fetch a single tenant (founder, or the user's own tenant)
 *   - create       — provision a new tenant (founder-only); tenant insert +
 *                    audit committed atomically in one DB transaction (see
 *                    `tenantsRepo.createWithAuditAtomic`, issue #184)
 *   - updateStatus — change tenant status active|suspended (founder-only);
 *                    flip + audit committed atomically in one DB transaction
 *                    (see `tenantsRepo.updateStatusAtomic`, issue #165)
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

  /**
   * Provision a new tenant.
   *
   * Codex Adversarial Review on PR #180 (issue #184) — delegates to
   * `tenantsRepo.createWithAuditAtomic`, which wraps the tenant insert and
   * the `admin_audit_log` append in a single DB transaction. If the audit
   * insert fails (or the request is interrupted), the tenant insert rolls
   * back together with it — preserving the append-only mutation-trail
   * invariant for tenant provisioning. Pre-fix, an interrupted audit step
   * left the tenant row committed with no forensic record, and a retry hit
   * CONFLICT (primary-key violation) without ever re-attempting the audit.
   *
   * The pre-flight `findById` is gone: the atomic repo method handles the
   * duplicate-id case via Postgres `23505` and returns a typed reason, so
   * we map it to CONFLICT without an extra round trip and without a TOCTOU
   * window between the existence check and the INSERT.
   *
   * Mirrors the pattern from `updateStatusAtomic` (issue #165 / PR #169)
   * and `agentsRepo.createWithSeedAndAudit` (issue #166 / PR #171).
   */
  create: founderProcedure.input(CreateInputSchema).mutation(async ({ input, ctx }) => {
    const result = await ctx.repos.tenantsRepo.createWithAuditAtomic({
      tenant: {
        id: input.id,
        nome: input.nome,
        status: input.status ?? 'active',
      },
      audit: {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
      },
    });

    if (!result.ok) {
      if (result.reason === 'duplicate_id') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Tenant '${input.id}' already exists`,
        });
      }
      // Exhaustiveness check — any future reason must be handled above.
      const _exhaustive: never = result.reason;
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `createWithAuditAtomic failed: ${String(_exhaustive)}`,
      });
    }

    return result.tenant;
  }),

  /**
   * Change a tenant's status (active|suspended).
   *
   * Codex Adversarial Review round 3 on PR #163 (issue #165) — delegates to
   * `tenantsRepo.updateStatusAtomic`, which wraps the status flip and the
   * `admin_audit_log` append in a single DB transaction. If the audit insert
   * fails (or the request is interrupted), the status change rolls back
   * together with it, preserving the append-only mutation-trail invariant.
   *
   * The pre-flight `findById` is gone: the atomic repo method does its own
   * locked re-read inside the tx and returns a discriminated union so we can
   * map outcomes to TRPC codes without a TOCTOU window. (Two concurrent
   * founders racing to suspend the same tenant now serialize on the
   * SELECT FOR UPDATE — only one wins, the other returns `already_in_status`.)
   */
  updateStatus: founderProcedure
    .input(UpdateStatusInputSchema)
    .mutation(async ({ input, ctx }) => {
      const result = await ctx.repos.tenantsRepo.updateStatusAtomic({
        id: input.id,
        status: input.status,
        audit: {
          tenant_id: ctx.tenantId,
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
          comment: input.comment,
        },
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' });
        }
        if (result.reason === 'already_in_status') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Tenant is already ${input.status}`,
          });
        }
        // Exhaustiveness check — any future reason must be handled above.
        const _exhaustive: never = result.reason;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `updateStatusAtomic failed: ${String(_exhaustive)}`,
        });
      }

      return result.after;
    }),
});
