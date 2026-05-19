/**
 * P8.5 — tRPC context. Builds per-request session + tenant assertion + repos.
 *
 * Post-Codex-review #101: every tRPC procedure consumes `ctx.tenantId` derived
 * exclusively from the authenticated NextAuth session. There is no path by
 * which a request body can override the session tenant — see also
 * src/admin-ui/trpc/tenant-resolver.ts (which permits founder-cross-tenant
 * only).
 */
import { TRPCError } from '@trpc/server';
import { auth } from '../lib/auth.js';
import * as repos from '../../db/repositories.js';

export interface CreateContextOptions {
  headers?: Headers;
}

export async function createTRPCContext(_opts?: CreateContextOptions) {
  const session = await auth();

  return {
    session,
    userId: session?.user?.id ?? null,
    userRole: session?.user?.role ?? null,
    tenantId: session?.user?.tenant_id ?? null,
    repos,

    /**
     * assertTenant — guards every procedure against cross-tenant reads/writes.
     * `founder` users may target any tenant explicitly via `?tenantId=` (so support
     * + impersonation works), all other roles can only access their own tenant.
     */
    assertTenant(input_tenant: string): void {
      if (!session?.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }
      if (session.user.role === 'founder') return;
      if (input_tenant !== session.user.tenant_id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Tenant isolation violation',
        });
      }
    },

    /**
     * assertRole — restricts a procedure to a list of accepted roles.
     */
    assertRole(...allowed: string[]): void {
      if (!session?.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }
      if (!allowed.includes(session.user.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Role ${session.user.role} not in allowed: [${allowed.join(', ')}]`,
        });
      }
    },
  };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;
