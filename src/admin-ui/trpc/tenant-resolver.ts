/**
 * P8.5 — Tenant resolution helper for tRPC procedures.
 *
 * Post-Codex-review #101: the tenantId an operation runs against MUST be derived
 * from the authenticated session, never from the request body. This helper:
 *
 *   1. Treats `ctx.tenantId` (NextAuth session.user.tenant_id) as source of truth.
 *   2. Treats an optional `input.tenantId` as a sanity-check value only. If the
 *      caller passes one and the session role is NOT 'founder', it must equal
 *      the session value or the request is rejected with FORBIDDEN.
 *   3. Allows founders to operate against any tenant (cross-tenant support).
 *
 * Property-test invariant: for any (sessionTenant, role, inputTenant) tuple
 * where role ∈ {owner, compliance_officer, analyst, viewer} and inputTenant ≠
 * sessionTenant, this function THROWS. Tested in tenant-resolver.spec.ts.
 */
import { TRPCError } from '@trpc/server';

export interface TenantResolverCtx {
  tenantId: string;
  userRole: string;
}

export function resolveTenantId(
  ctx: TenantResolverCtx,
  inputTenantId?: string,
): string {
  if (!inputTenantId) return ctx.tenantId;
  if (ctx.userRole === 'founder') return inputTenantId;
  if (inputTenantId !== ctx.tenantId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Tenant isolation violation: input.tenantId must match session tenant',
    });
  }
  return ctx.tenantId;
}
