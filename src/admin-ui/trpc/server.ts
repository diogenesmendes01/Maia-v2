/**
 * P8.5 — tRPC v11 server initialization + middlewares.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from './context.js';

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * protectedProcedure — guarantees `ctx.session.user` is present AND that the
 * session's tenant is in an `active` status.
 *
 * Tenant-suspension enforcement (Codex review of PR #162, finding [high]): if
 * a founder suspends a tenant via `tenants.updateStatus`, the existing
 * sessions must stop working. We check `tenants.status` on every request and
 * reject suspended tenants with FORBIDDEN — EXCEPT for founders, who keep
 * cross-tenant access to investigate/reactivate.
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.session?.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }

  const sessionTenant = opts.ctx.session.user.tenant_id;
  const role = opts.ctx.session.user.role;

  // Founders may operate cross-tenant (including against a suspended one) so
  // they can investigate and reactivate. Everyone else is blocked the moment
  // their home tenant goes 'suspended'.
  //
  // The check is skipped when `repos.tenantsRepo` isn't wired (unit-test
  // contexts that build a minimal repo mock to drive a specific router); the
  // production tRPC handler always wires the full repo set via
  // `createTRPCContext`.
  if (role !== 'founder' && opts.ctx.repos.tenantsRepo) {
    const tenant = await opts.ctx.repos.tenantsRepo.findById(sessionTenant);
    if (!tenant) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Session tenant no longer exists',
      });
    }
    if (tenant.status !== 'active') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Tenant '${sessionTenant}' is ${tenant.status} — access denied`,
      });
    }
  }

  return opts.next({
    ctx: {
      ...opts.ctx,
      // Narrow types: after this middleware, session/user are guaranteed.
      session: opts.ctx.session,
      userId: opts.ctx.session.user.id,
      userRole: role,
      tenantId: sessionTenant,
    },
  });
});

/**
 * founderProcedure — restricted to role=founder. Used for Architecture Lock
 * decisions and cross-tenant operations.
 */
export const founderProcedure = protectedProcedure.use(async (opts) => {
  if (opts.ctx.userRole !== 'founder') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Founder role required',
    });
  }
  return opts.next({ ctx: opts.ctx });
});
