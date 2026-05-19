/**
 * P8.5 — versionsRouter unit tests (post Codex review #101).
 *
 * Verifies that rollback NO LONGER fakes success. Until a per-SoT
 * implementation lands, every rollback attempt:
 *   1. Writes an audit row (action='version_rollback_attempt').
 *   2. Throws NOT_IMPLEMENTED with a clear message.
 *
 * Pre-fix: returned { status: 'rolled_back' } for every SoT, even though no
 * actual mutation happened. That was a critical false-positive during incident
 * response.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { versionsRouter } from '@/admin-ui/trpc/routers/versions.js';

type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown> | null;
};

function makeCtx(role: string) {
  const audit: AuditRow[] = [];
  return {
    ctx: {
      session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
      userId: 'user-1',
      userRole: role,
      tenantId: 'tenant-A',
      repos: {
        adminAuditLogRepo: {
          async append(row: AuditRow) {
            audit.push(row);
            return { ...row, id: audit.length, created_at: new Date() };
          },
        },
      } as unknown as typeof import('@/db/repositories.js'),
      assertTenant: () => {},
      assertRole: () => {},
    },
    audit,
  };
}

describe('versionsRouter.rollback — fail loud, not silent', () => {
  it('throws NOT_IMPLEMENTED for agent_operational_profile_versions', async () => {
    const { ctx, audit } = makeCtx('owner');
    const caller = versionsRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.rollback({
        sotKind: 'agent_operational_profile_versions',
        sotId: 'profile-1',
        fromVersion: 5,
        toVersion: 3,
        reason: 'incident-2026-05-01-revert',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('NOT_IMPLEMENTED');
    // Audit was still recorded — operators can see who tried.
    expect(audit.length).toBe(1);
    expect(audit[0]?.action).toBe('version_rollback_attempt');
  });

  it('throws NOT_IMPLEMENTED for policy_rules', async () => {
    const { ctx } = makeCtx('founder');
    const caller = versionsRouter.createCaller(ctx);
    await expect(
      caller.rollback({
        sotKind: 'policy_rules',
        sotId: 'pr-1',
        fromVersion: 2,
        toVersion: 1,
        reason: 'policy-drift-correction',
      }),
    ).rejects.toThrowError(/not implemented/i);
  });

  it('rejects invalid rollback target (target >= current)', async () => {
    const { ctx } = makeCtx('owner');
    const caller = versionsRouter.createCaller(ctx);
    await expect(
      caller.rollback({
        sotKind: 'agent_operational_profile_versions',
        sotId: 'profile-1',
        fromVersion: 3,
        toVersion: 5, // forward, not back
        reason: 'attempt to "roll forward"',
      }),
    ).rejects.toThrowError(/BAD_REQUEST|Invalid rollback target/);
  });

  it('listVersions returns the not_implemented flag (operators see honest state)', async () => {
    const { ctx } = makeCtx('viewer');
    const caller = versionsRouter.createCaller(ctx);
    const res = await caller.listVersions({
      sotKind: 'agent_operational_profile_versions',
    });
    expect(res.items).toEqual([]);
    expect(res.not_implemented).toBe(true);
  });
});
