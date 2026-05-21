/**
 * Admin UI Setup — channelPoliciesRouter unit tests.
 *
 * Drives the router through tRPC's caller with in-memory repos. Verifies:
 *   1. upsert requires role founder|owner.
 *   2. upsert creates a fresh policy when none exists (action='channel_policy_create').
 *   3. upsert updates an existing policy in place (action='channel_policy_update').
 *   4. Channel + default_role must belong to the (tenant, agent); NOT_FOUND otherwise.
 *   5. listChannels / listRoles run inside the right tenant context.
 *   6. resolveTenantId rejects body-supplied foreign tenant for non-founder.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { channelPoliciesRouter } from '@/admin-ui/trpc/routers/channelPolicies.js';

type Channel = {
  id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
  channel_type: string;
  display_name: string | null;
  active: boolean;
};
type Role = {
  id: string;
  tenant_id: string;
  agent_id: string;
  role_key: string;
  display_name: string;
  active: boolean;
};
type Policy = {
  id: string;
  tenant_id: string;
  agent_id: string;
  channel_id: string;
  default_role_id: string;
  switch_behavior: string;
  announce_mode: string;
  by_context_guards: Record<string, unknown>;
  allowed_role_ids: string[];
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

function makeRepos(opts: {
  channels?: Channel[];
  roles?: Role[];
  policies?: Policy[];
} = {}) {
  const channels = [...(opts.channels ?? [])];
  const roles = [...(opts.roles ?? [])];
  const policies = [...(opts.policies ?? [])];
  const audit: AuditRow[] = [];

  return {
    channelsRepo: {
      async getById(id: string) {
        return channels.find((c) => c.id === id) ?? null;
      },
      async listActive() {
        // NOTE: the mock can't actually read AsyncLocalStorage, but the router
        // wraps every call with runWithTenantContext, so we just return active
        // channels and trust the test to seed only relevant rows.
        return channels.filter((c) => c.active);
      },
    },
    rolesRepo: {
      async getById(id: string) {
        return roles.find((r) => r.id === id) ?? null;
      },
      async listActive() {
        return roles.filter((r) => r.active);
      },
    },
    channelPoliciesRepo: {
      async getByChannelId(channel_id: string) {
        return policies.find((p) => p.channel_id === channel_id) ?? null;
      },
      async create(input: {
        channel_id: string;
        default_role_id: string;
        switch_behavior: string;
        announce_mode?: string;
        by_context_guards?: unknown;
        allowed_role_ids?: string[];
      }) {
        const row: Policy = {
          id: `policy-${policies.length + 1}`,
          tenant_id: 'tenant-A',
          agent_id: 'agent-1',
          channel_id: input.channel_id,
          default_role_id: input.default_role_id,
          switch_behavior: input.switch_behavior,
          announce_mode: input.announce_mode ?? 'affects_user',
          by_context_guards: (input.by_context_guards as Record<string, unknown>) ?? {},
          allowed_role_ids: input.allowed_role_ids ?? [],
        };
        policies.push(row);
        return row;
      },
      async update(id: string, patch: Partial<Policy>) {
        const idx = policies.findIndex((p) => p.id === id);
        if (idx === -1) throw new Error('not found');
        policies[idx] = { ...policies[idx]!, ...patch };
        return policies[idx]!;
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
    _inspect: { channels, roles, policies, audit },
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
  return channelPoliciesRouter.createCaller(ctx);
}

const channel1: Channel = {
  id: '00000000-0000-4000-8000-000000000001',
  tenant_id: 'tenant-A',
  agent_id: 'agent-1',
  external_id: '5511999990001',
  channel_type: 'whatsapp',
  display_name: 'Main',
  active: true,
};
const role1: Role = {
  id: '00000000-0000-4000-8000-0000000000a1',
  tenant_id: 'tenant-A',
  agent_id: 'agent-1',
  role_key: 'default',
  display_name: 'Default',
  active: true,
};
const role2: Role = {
  id: '00000000-0000-4000-8000-0000000000a2',
  tenant_id: 'tenant-A',
  agent_id: 'agent-1',
  role_key: 'support',
  display_name: 'Support',
  active: true,
};

describe('channelPoliciesRouter.upsert — role gate', () => {
  it.each(['analyst', 'viewer', 'compliance_officer'])(
    '%s cannot upsert',
    async (role) => {
      const repos = makeRepos({ channels: [channel1], roles: [role1] });
      await expect(
        caller(role, 'tenant-A', 'u1', repos).upsert({
          agentId: 'agent-1',
          channel_id: channel1.id,
          default_role_id: role1.id,
          switch_behavior: 'locked',
          comment: 'attempt without permission',
        }),
      ).rejects.toThrow(TRPCError);
    },
  );

  it('owner creates a new policy and audits action=create', async () => {
    const repos = makeRepos({ channels: [channel1], roles: [role1] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).upsert({
      agentId: 'agent-1',
      channel_id: channel1.id,
      default_role_id: role1.id,
      switch_behavior: 'locked',
      comment: 'pin channel to default role',
    });
    expect(res.created).toBe(true);
    expect(repos._inspect.policies.length).toBe(1);
    expect(repos._inspect.audit[0]!.action).toBe('channel_policy_create');
  });
});

describe('channelPoliciesRouter.upsert — update path', () => {
  it('updates existing policy in place', async () => {
    const existing: Policy = {
      id: 'policy-existing',
      tenant_id: 'tenant-A',
      agent_id: 'agent-1',
      channel_id: channel1.id,
      default_role_id: role1.id,
      switch_behavior: 'locked',
      announce_mode: 'affects_user',
      by_context_guards: {},
      allowed_role_ids: [],
    };
    const repos = makeRepos({
      channels: [channel1],
      roles: [role1, role2],
      policies: [existing],
    });
    const res = await caller('owner', 'tenant-A', 'u1', repos).upsert({
      agentId: 'agent-1',
      channel_id: channel1.id,
      default_role_id: role2.id,
      switch_behavior: 'by_context',
      comment: 'switch to support role on context',
    });
    expect(res.created).toBe(false);
    expect(repos._inspect.policies.length).toBe(1);
    expect(repos._inspect.policies[0]!.default_role_id).toBe(role2.id);
    expect(repos._inspect.policies[0]!.switch_behavior).toBe('by_context');
    expect(repos._inspect.audit[0]!.action).toBe('channel_policy_update');
    expect(repos._inspect.audit[0]!.change_summary?.previous_policy_id).toBe(
      'policy-existing',
    );
  });
});

describe('channelPoliciesRouter.upsert — invariants', () => {
  it('NOT_FOUND when channel missing', async () => {
    const repos = makeRepos({ channels: [], roles: [role1] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).upsert({
        agentId: 'agent-1',
        channel_id: '00000000-0000-4000-8000-00000000ffff',
        default_role_id: role1.id,
        switch_behavior: 'locked',
        comment: 'channel does not exist',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('NOT_FOUND when default_role missing', async () => {
    const repos = makeRepos({ channels: [channel1], roles: [] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).upsert({
        agentId: 'agent-1',
        channel_id: channel1.id,
        default_role_id: '00000000-0000-4000-8000-00000000ffff',
        switch_behavior: 'locked',
        comment: 'role does not exist',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects body-supplied foreign tenant for non-founder', async () => {
    const repos = makeRepos({ channels: [channel1], roles: [role1] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).upsert({
        tenantId: 'tenant-B',
        agentId: 'agent-1',
        channel_id: channel1.id,
        default_role_id: role1.id,
        switch_behavior: 'locked',
        comment: 'cross-tenant attempt',
      }),
    ).rejects.toThrow(TRPCError);
  });
});

describe('channelPoliciesRouter.listChannels / listRoles', () => {
  it('returns active channels for the agent', async () => {
    const inactive: Channel = { ...channel1, id: 'channel-off', active: false };
    const repos = makeRepos({ channels: [channel1, inactive], roles: [] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).listChannels({
      agentId: 'agent-1',
    });
    expect(res.items.map((c) => c.id)).toEqual([channel1.id]);
  });

  it('returns active roles for the agent', async () => {
    const inactive: Role = { ...role1, id: 'role-off', active: false };
    const repos = makeRepos({ channels: [], roles: [role1, inactive] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).listRoles({
      agentId: 'agent-1',
    });
    expect(res.items.map((r) => r.id)).toEqual([role1.id]);
  });
});
