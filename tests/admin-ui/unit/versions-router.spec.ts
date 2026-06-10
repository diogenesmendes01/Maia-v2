/**
 * P8.5 — versionsRouter unit tests.
 *
 * Two surfaces:
 *   - rollback() still fails loud (NOT_IMPLEMENTED) because no per-SoT
 *     transition is wired yet — that pre-existing behavior is retained.
 *   - listVersions() now returns real rows for agent_operational_profile_versions
 *     (the only SoT with a list helper on main); other SoTs surface
 *     partially_implemented for observability.
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

type ProfileVersion = {
  id: string;
  tenant_id: string;
  agent_id: string;
  version: number;
  status: 'proposed' | 'active' | 'frozen' | 'rolled_back';
  created_at: Date;
};

function makeCtx(
  role: string,
  opts?: {
    agents?: string[];
    versions?: ProfileVersion[];
    rollbackResult?: unknown;
  },
) {
  const audit: AuditRow[] = [];
  const rollbackCalls: Array<Record<string, unknown>> = [];
  const agentList = (opts?.agents ?? []).map((id) => ({
    id,
    tenant_id: 'tenant-A',
    nome: id,
    status: 'active',
  }));
  const versionsByAgent: Record<string, ProfileVersion[]> = {};
  for (const v of opts?.versions ?? []) {
    (versionsByAgent[v.agent_id] ??= []).push(v);
  }

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
        agentsRepo: {
          async listByTenant(_tenant_id: string) {
            return agentList;
          },
        },
        operationalProfileVersionsRepo: {
          // Read tenant context via runWithTenantContext from the test? The
          // router wraps each call with runWithTenantContext({ tenant, agent }).
          // The mock falls back: filters its in-memory versions by status only;
          // tenant scoping is asserted in dedicated repo tests, not here.
          async listByStatus(status: string) {
            return (
              opts?.versions?.filter(
                (v) =>
                  v.status === status &&
                  Object.values(versionsByAgent).some((arr) => arr.includes(v)),
              ) ?? []
            );
          },
          async getActive() {
            return opts?.versions?.find((v) => v.status === 'active') ?? null;
          },
          async adminRollbackAtomic(args: Record<string, unknown>) {
            rollbackCalls.push(args);
            return (
              opts?.rollbackResult ?? {
                ok: true,
                activated: { id: 'pv-target', version: args.to_version },
                rolled_back: { id: 'pv-active', version: args.from_version },
              }
            );
          },
        },
      } as unknown as typeof import('@/db/repositories.js'),
      assertTenant: () => {},
      assertRole: () => {},
    },
    audit,
    rollbackCalls,
  };
}

describe('versionsRouter.rollback — fail loud, not silent', () => {
  it('agent_operational_profile_versions: executes adminRollbackAtomic and returns the transition', async () => {
    const { ctx, audit, rollbackCalls } = makeCtx('owner');
    const caller = versionsRouter.createCaller(ctx);
    const result = await caller.rollback({
      sotKind: 'agent_operational_profile_versions',
      sotId: 'agent-a',
      fromVersion: 5,
      toVersion: 3,
      reason: 'incident-2026-06-10-revert',
    });
    expect(result.status).toBe('rolled_back');
    expect(result.activated).toEqual({ id: 'pv-target', version: 3 });
    expect(result.rolled_back).toEqual({ id: 'pv-active', version: 5 });
    // The repo receives the agent id (sotId) + actor context for the
    // in-tx completion audit.
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      from_version: 5,
      to_version: 3,
      actor_id: 'user-1',
      actor_role: 'owner',
      reason: 'incident-2026-06-10-revert',
    });
    // Attempt audit (pre-tx) still recorded, now with implemented: true.
    expect(audit.length).toBe(1);
    expect(audit[0]?.action).toBe('version_rollback_attempt');
    expect(audit[0]?.change_summary?.implemented).toBe(true);
  });

  it('maps active_mismatch to CONFLICT (stale screen)', async () => {
    const { ctx } = makeCtx('owner', {
      rollbackResult: { ok: false, reason: 'active_mismatch', actual_active_version: 6 },
    });
    const caller = versionsRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.rollback({
        sotKind: 'agent_operational_profile_versions',
        sotId: 'agent-a',
        fromVersion: 5,
        toVersion: 3,
        reason: 'stale operator decision',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('CONFLICT');
    expect((thrown as TRPCError).message).toMatch(/v6/);
  });

  it('maps target_invalid_status to PRECONDITION_FAILED (cannot re-activate proposed/rolled_back)', async () => {
    const { ctx } = makeCtx('founder', {
      rollbackResult: { ok: false, reason: 'target_invalid_status', actual_status: 'rolled_back' },
    });
    const caller = versionsRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.rollback({
        sotKind: 'agent_operational_profile_versions',
        sotId: 'agent-a',
        fromVersion: 5,
        toVersion: 2,
        reason: 'rollback to terminal row',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((thrown as TRPCError).message).toMatch(/rolled_back/);
  });

  it('maps agent_missing to NOT_FOUND', async () => {
    const { ctx } = makeCtx('owner', {
      rollbackResult: { ok: false, reason: 'agent_missing' },
    });
    const caller = versionsRouter.createCaller(ctx);
    await expect(
      caller.rollback({
        sotKind: 'agent_operational_profile_versions',
        sotId: 'ghost-agent',
        fromVersion: 5,
        toVersion: 3,
        reason: 'agent deleted concurrently',
      }),
    ).rejects.toThrowError(/Agent not found/);
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

  it('listVersions returns operational_profile_versions across the tenant', async () => {
    const v1: ProfileVersion = {
      id: 'pv-1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      version: 1,
      status: 'active',
      created_at: new Date('2026-04-01'),
    };
    const v2: ProfileVersion = {
      id: 'pv-2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      version: 2,
      status: 'proposed',
      created_at: new Date('2026-05-01'),
    };
    const { ctx } = makeCtx('viewer', {
      agents: ['agent-a'],
      versions: [v1, v2],
    });
    const caller = versionsRouter.createCaller(ctx);
    const res = await caller.listVersions({
      sotKind: 'agent_operational_profile_versions',
    });
    expect(res.items.length).toBe(2);
    // newest-first
    expect(res.items[0]!.id).toBe('pv-2');
    expect(res.partially_implemented).toEqual([]);
  });

  it('listVersions for unwired SoT surfaces partially_implemented honestly', async () => {
    const { ctx } = makeCtx('viewer', { agents: [] });
    const caller = versionsRouter.createCaller(ctx);
    const res = await caller.listVersions({ sotKind: 'policy_rules' });
    expect(res.items).toEqual([]);
    expect(res.partially_implemented).toEqual(['policy_rules']);
  });
});
