/**
 * P8.5 — tRPC v11 server initialization + middlewares.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from './context.js';

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * protectedProcedure — guarantees `ctx.session.user` is present.
 * Use as the default for every admin-ui endpoint.
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  if (!opts.ctx.session?.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  return opts.next({
    ctx: {
      ...opts.ctx,
      // Narrow types: after this middleware, session/user are guaranteed.
      session: opts.ctx.session,
      userId: opts.ctx.session.user.id,
      userRole: opts.ctx.session.user.role,
      tenantId: opts.ctx.session.user.tenant_id,
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
