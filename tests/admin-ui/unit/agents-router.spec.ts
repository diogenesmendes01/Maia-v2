/**
 * Admin UI Setup — agentsRouter unit tests.
 *
 * Drives the router through tRPC's caller with in-memory repos. Verifies:
 *   1. create requires role founder|owner; viewer/analyst/compliance get FORBIDDEN.
 *   2. create writes the agent row AND seeds an operational_profile_version
 *      with status='proposed' AND appends an audit row, in that order.
 *   3. create against a non-existent tenant returns NOT_FOUND.
 *   4. create with a duplicate agent id returns CONFLICT.
 *   5. updateProfile chains previous_version_id from the active version.
 *   6. updateProfile on a foreign-tenant agent returns NOT_FOUND (tenant
 *      isolation invariant).
 *   7. resolveTenantId still rejects a body-supplied tenant for non-founder.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { agentsRouter } from '@/admin-ui/trpc/routers/agents.js';

type Agent = {
  id: string;
  tenant_id: string;
  nome: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};
type Profile = {
  id: string;
  tenant_id: string;
  agent_id: string;
  version: number;
  status: string;
  profile_body: unknown;
  proposed_by: string;
  proposed_reason: string | null;
};
type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown> | null;
};

function makeRepos(opts: { tenants?: string[]; agents?: Agent[]; profiles?: Profile[] } = {}) {
  const tenantIds = new Set(opts.tenants ?? ['tenant-A']);
  const agentsMap: Record<string, Agent> = {};
  for (const a of opts.agents ?? []) agentsMap[a.id] = { ...a };
  const profiles: Profile[] = [...(opts.profiles ?? [])];
  const audit: AuditRow[] = [];

  return {
    tenantsRepo: {
      async findById(id: string) {
        return tenantIds.has(id)
          ? {
              id,
              nome: id,
              status: 'active',
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            }
          : null;
      },
    },
    agentsRepo: {
      async findById(id: string) {
        return agentsMap[id] ?? null;
      },
      async listByTenant(tenant_id: string) {
        return Object.values(agentsMap).filter((a) => a.tenant_id === tenant_id);
      },
      async create(input: {
        id: string;
        tenant_id: string;
        nome: string;
        status?: string;
      }) {
        const row: Agent = {
          id: input.id,
          tenant_id: input.tenant_id,
          nome: input.nome,
          status: input.status ?? 'active',
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        agentsMap[input.id] = row;
        return row;
      },
    },
    operationalProfileVersionsRepo: {
      // The real repo uses applyTenantGuard + getCurrentTenant(); the router
      // wraps these calls in runWithTenantContext, so by the time we get here
      // the AsyncLocalStorage is populated. We mirror that by reading from
      // the storage too — but to keep the mock simple we accept that the
      // router wraps and trust the context.
      async getActive() {
        // The router calls this inside runWithTenantContext({ tenant_id, agent_id });
        // we cannot read AsyncLocalStorage from a Promise that resolves synchronously
        // unless we wire it. For the unit test, infer the latest 'active' profile
        // from the profiles list. This is sufficient for the assertions made.
        const active = profiles.find((p) => p.status === 'active');
        return active ?? null;
      },
      async create(input: {
        profile_body: unknown;
        proposed_by: string;
        proposed_reason?: string;
      }) {
        // We can't read the tenant context from the test mock easily, but the
        // router always passes the SAME tenant+agent in runWithTenantContext as
        // the one supplied to agentsRepo.create. So we tag from the latest agent
        // create (best-effort for tests).
        const lastAgent = Object.values(agentsMap).at(-1);
        const tenant_id = lastAgent?.tenant_id ?? 'unknown';
        const agent_id = lastAgent?.id ?? 'unknown';
        const version =
          profiles.filter((p) => p.tenant_id === tenant_id && p.agent_id === agent_id)
            .length + 1;
        const row: Profile = {
          id: `prof-${profiles.length + 1}`,
          tenant_id,
          agent_id,
          version,
          status: 'proposed',
          profile_body: input.profile_body,
          proposed_by: input.proposed_by,
          proposed_reason: input.proposed_reason ?? null,
        };
        profiles.push(row);
        return row;
      },
      // Mirrors the tx-aware repo path: finds the target proposed row, freezes
      // any incumbent active for the same (tenant, agent), activates the new
      // one, audits — all "atomically" in mock-land (just runs synchronously).
      async approveAndActivateAtomic(args: {
        tenant_id: string;
        agent_id: string;
        id: string;
        actor_id: string;
        actor_role: string;
        comment: string;
      }) {
        const target = profiles.find((p) => p.id === args.id);
        if (!target) return { ok: false as const, reason: 'not_found' as const };
        if (target.status !== 'proposed') {
          return { ok: false as const, reason: 'invalid_source_status' as const };
        }
        const incumbent =
          profiles.find(
            (p) =>
              p.tenant_id === args.tenant_id &&
              p.agent_id === args.agent_id &&
              p.status === 'active' &&
              p.id !== target.id,
          ) ?? null;
        if (incumbent) {
          incumbent.status = 'frozen';
        }
        target.status = 'active';
        audit.push({
          tenant_id: args.tenant_id,
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          action: 'agent_profile_approve',
          resource_type: 'agent_operational_profile_version',
          resource_id: target.id,
          change_summary: {
            agent_id: args.agent_id,
            new_version_id: target.id,
            new_version: target.version,
            previous_active_id: incumbent?.id ?? null,
            previous_active_version: incumbent?.version ?? null,
            comment: args.comment,
          },
        });
        return {
          ok: true as const,
          activated: { id: target.id, version: target.version },
          frozen_previous: incumbent
            ? { id: incumbent.id, version: incumbent.version }
            : null,
        };
      },
    },
    adminAuditLogRepo: {
      async append(entry: AuditRow) {
        audit.push(entry);
        return { ...entry, id: audit.length, created_at: new Date() } as AuditRow & {
          id: number;
          created_at: Date;
        };
      },
    },
    _inspect: { agentsMap, profiles, audit },
  };
}

function caller(
  role: string,
  sessionTenant: string,
  userId: string,
  repos: ReturnType<typeof makeRepos>,
) {
  const ctx = {
    session: { user: { id: userId, role, tenant_id: sessionTenant } },
    userId,
    userRole: role,
    tenantId: sessionTenant,
    repos: repos as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `role ${role} not in ${allowed.join(',')}`,
        });
      }
    },
  };
  return agentsRouter.createCaller(ctx);
}

const validProfile = {
  identity: {
    role_descriptor: 'assistente fiscal',
    voice: { tone: 'profissional', formality: 'medium', verbosity: 'medium' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['precisao', 'clareza'],
  },
  style: { language: 'pt-BR', rhythm: {} },
} as const;

describe('agentsRouter.create — role gate', () => {
  it.each(['analyst', 'viewer', 'compliance_officer'])(
    '%s gets FORBIDDEN',
    async (role) => {
      const repos = makeRepos();
      await expect(
        caller(role, 'tenant-A', 'u1', repos).create({
          id: 'agent-x',
          nome: 'X',
          profile_body: validProfile,
          proposed_reason: 'seed for X division',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );

  it('owner can create in own tenant', async () => {
    const repos = makeRepos();
    const res = await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfile,
      proposed_reason: 'seed for X division',
    });
    expect(res.agent.id).toBe('agent-x');
    expect(res.seed_profile.status).toBe('proposed');
    expect(res.seed_profile.version).toBe(1);
  });

  it('owner cannot create across tenants (body tenant rejected)', async () => {
    const repos = makeRepos({ tenants: ['tenant-A', 'tenant-B'] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        tenantId: 'tenant-B',
        id: 'agent-spy',
        nome: 'Spy',
        profile_body: validProfile,
        proposed_reason: 'try to cross tenants',
      }),
    ).rejects.toThrow(TRPCError);
  });

  it('founder can create across tenants', async () => {
    const repos = makeRepos({ tenants: ['tenant-A', 'tenant-B'] });
    const res = await caller('founder', 'home', 'f1', repos).create({
      tenantId: 'tenant-B',
      id: 'agent-b',
      nome: 'B',
      profile_body: validProfile,
      proposed_reason: 'cross-tenant founder ops',
    });
    expect(res.agent.tenant_id).toBe('tenant-B');
  });
});

describe('agentsRouter.create — invariants', () => {
  it('NOT_FOUND when tenant missing', async () => {
    const repos = makeRepos({ tenants: [] });
    await expect(
      caller('founder', 'home', 'f1', repos).create({
        tenantId: 'ghost-tenant',
        id: 'agent-x',
        nome: 'X',
        profile_body: validProfile,
        proposed_reason: 'tenant does not exist',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('CONFLICT on duplicate agent id', async () => {
    const dup: Agent = {
      id: 'agent-x',
      tenant_id: 'tenant-A',
      nome: 'old',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const repos = makeRepos({ agents: [dup] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'new',
        profile_body: validProfile,
        proposed_reason: 'duplicate id attempt',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('audits with seed_profile_version_id + status=proposed', async () => {
    const repos = makeRepos();
    await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfile,
      proposed_reason: 'seed for X division',
    });
    const audit = repos._inspect.audit[0]!;
    expect(audit.action).toBe('agent_create');
    expect(audit.change_summary?.seed_profile_status).toBe('proposed');
    expect(audit.change_summary?.seed_profile_version).toBe(1);
  });
});

describe('agentsRouter.updateProfile — invariants', () => {
  const existingAgent: Agent = {
    id: 'agent-x',
    tenant_id: 'tenant-A',
    nome: 'X',
    status: 'active',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('owner can propose a new version', async () => {
    const repos = makeRepos({ agents: [existingAgent] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile,
      proposed_reason: 'update tone for Q2 launch',
    });
    expect(res.version.status).toBe('proposed');
    expect(res.previous_version_id).toBeNull();
  });

  it('chains previous_version_id from active', async () => {
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [
        {
          id: 'prof-active',
          tenant_id: 'tenant-A',
          agent_id: 'agent-x',
          version: 1,
          status: 'active',
          profile_body: {},
          proposed_by: 'system',
          proposed_reason: null,
        },
      ],
    });
    const res = await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile,
      proposed_reason: 'change priorities — see ticket',
    });
    expect(res.previous_version_id).toBe('prof-active');
  });

  it('foreign-tenant agent returns NOT_FOUND', async () => {
    const repos = makeRepos({
      agents: [
        {
          ...existingAgent,
          tenant_id: 'tenant-B',
        },
      ],
    });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).updateProfile({
        agentId: 'agent-x',
        profile_body: validProfile,
        proposed_reason: 'cross-tenant attempt',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['analyst', 'viewer', 'compliance_officer'])(
    '%s cannot updateProfile',
    async (role) => {
      const repos = makeRepos({ agents: [existingAgent] });
      await expect(
        caller(role, 'tenant-A', 'u1', repos).updateProfile({
          agentId: 'agent-x',
          profile_body: validProfile,
          proposed_reason: 'unauthorised update attempt',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );
});

describe('agentsRouter.approveProfile — atomic + freezes incumbent', () => {
  const existingAgent: Agent = {
    id: 'agent-x',
    tenant_id: 'tenant-A',
    nome: 'X',
    status: 'active',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it.each(['analyst', 'viewer', 'compliance_officer'])(
    '%s cannot approve',
    async (role) => {
      const proposed: Profile = {
        id: '00000000-0000-4000-8000-0000000000a1',
        tenant_id: 'tenant-A',
        agent_id: 'agent-x',
        version: 1,
        status: 'proposed',
        profile_body: {},
        proposed_by: 'system',
        proposed_reason: null,
      };
      const repos = makeRepos({ agents: [existingAgent], profiles: [proposed] });
      await expect(
        caller(role, 'tenant-A', 'u1', repos).approveProfile({
          agentId: 'agent-x',
          versionId: '00000000-0000-4000-8000-0000000000a1',
          comment: 'no-permission attempt',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );

  it('owner approves seed v1 (no incumbent → no freeze)', async () => {
    const proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'proposed',
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [proposed] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).approveProfile({
      agentId: 'agent-x',
      versionId: '00000000-0000-4000-8000-0000000000a1',
      comment: 'first activation for this agent',
    });
    expect(res.activated.id).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(res.frozen_previous).toBeNull();
    expect(repos._inspect.profiles[0]!.status).toBe('active');
    // Audit row records the transition.
    expect(repos._inspect.audit[0]!.action).toBe('agent_profile_approve');
    expect(repos._inspect.audit[0]!.change_summary?.previous_active_id).toBeNull();
  });

  it('owner approves v2 while v1 active → v1 frozen, v2 active, audited atomically', async () => {
    const v1Active: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const v2Proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 2,
      status: 'proposed',
      profile_body: {},
      proposed_by: 'owner-1',
      proposed_reason: 'change tone',
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [v1Active, v2Proposed],
    });
    const res = await caller('owner', 'tenant-A', 'u1', repos).approveProfile({
      agentId: 'agent-x',
      versionId: '00000000-0000-4000-8000-0000000000a2',
      comment: 'promote v2 after review',
    });
    expect(res.activated.id).toBe('00000000-0000-4000-8000-0000000000a2');
    expect(res.frozen_previous?.id).toBe('00000000-0000-4000-8000-0000000000a1');
    // Old active → frozen, new proposed → active.
    expect(repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a1')!.status).toBe('frozen');
    expect(repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a2')!.status).toBe('active');
    // Audit records both sides of the swap.
    const audit = repos._inspect.audit[0]!;
    expect(audit.change_summary?.previous_active_id).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(audit.change_summary?.new_version_id).toBe('00000000-0000-4000-8000-0000000000a2');
  });

  it('CONFLICT when version is not in proposed state', async () => {
    const alreadyActive: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [alreadyActive],
    });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'approving an already-active row',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('NOT_FOUND when agent missing', async () => {
    const proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-ghost',
      version: 1,
      status: 'proposed',
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [], profiles: [proposed] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-ghost',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'agent does not exist',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
