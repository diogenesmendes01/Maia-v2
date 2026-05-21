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
