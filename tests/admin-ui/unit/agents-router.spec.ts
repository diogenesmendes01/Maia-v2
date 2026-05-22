/**
 * Admin UI Setup — agentsRouter unit tests.
 *
 * Drives the router through tRPC's caller with in-memory repos. Verifies:
 *   1. create requires role founder|owner; viewer/analyst/compliance get FORBIDDEN.
 *   2. create writes the agent row AND seeds an operational_profile_version
 *      with status='proposed' AND appends an audit row — ATOMICALLY (via
 *      agentsRepo.createWithSeedAndAudit; issue #166).
 *   3. create against a non-existent tenant returns NOT_FOUND.
 *   4. create with a duplicate agent id returns CONFLICT.
 *   5. updateProfile chains previous_version_id from the active version.
 *   6. updateProfile on a foreign-tenant agent returns NOT_FOUND (tenant
 *      isolation invariant).
 *   7. resolveTenantId still rejects a body-supplied tenant for non-founder.
 *   8. ATOMICITY (issue #166): if the audit insert throws inside
 *      createWithSeedAndAudit / proposeAndAuditAtomic, neither the agent row
 *      nor the profile_version row are persisted (full rollback).
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

/**
 * Options for makeRepos:
 *   - failAuditOnAction: when set, the audit insert performed inside the
 *     atomic helpers (createWithSeedAndAudit / proposeAndAuditAtomic) throws.
 *     The mock then ROLLS BACK the agent/profile writes performed earlier in
 *     the same logical tx, mirroring real Postgres `withTx` semantics. Used
 *     to prove the multi-write atomicity invariant (issue #166).
 */
function makeRepos(
  opts: {
    tenants?: string[];
    agents?: Agent[];
    profiles?: Profile[];
    failAuditOnAction?: 'agent_create' | 'agent_profile_propose';
  } = {},
) {
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
      // Atomic create+seed+audit. Mock emulates `withTx` rollback: if any of
      // the three writes throws, everything previously inserted in THIS call
      // is removed. Mirrors the real-DB invariant tested in #166.
      async createWithSeedAndAudit(args: {
        agent: {
          id: string;
          tenant_id: string;
          nome: string;
          status?: string;
        };
        seed_profile: {
          profile_body: unknown;
          proposed_by: string;
          proposed_reason: string;
        };
        audit: {
          actor_id: string;
          actor_role: string;
        };
      }) {
        // Snapshot for rollback.
        const insertedAgentId = args.agent.id;
        const insertedProfileIds: string[] = [];
        const insertedAuditIdx: number[] = [];
        try {
          // (1) Insert agent.
          const createdAgent: Agent = {
            id: args.agent.id,
            tenant_id: args.agent.tenant_id,
            nome: args.agent.nome,
            status: args.agent.status ?? 'active',
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          };
          agentsMap[insertedAgentId] = createdAgent;
          // (2) Insert seed profile_version (version=1, status=proposed).
          const seedProfile: Profile = {
            id: `prof-${profiles.length + 1}`,
            tenant_id: args.agent.tenant_id,
            agent_id: createdAgent.id,
            version: 1,
            status: 'proposed',
            profile_body: args.seed_profile.profile_body,
            proposed_by: args.seed_profile.proposed_by,
            proposed_reason: args.seed_profile.proposed_reason,
          };
          profiles.push(seedProfile);
          insertedProfileIds.push(seedProfile.id);
          // (3) Append audit. May throw if failAuditOnAction matches.
          if (opts.failAuditOnAction === 'agent_create') {
            throw new Error('simulated audit insert failure');
          }
          audit.push({
            tenant_id: args.agent.tenant_id,
            actor_id: args.audit.actor_id,
            actor_role: args.audit.actor_role,
            action: 'agent_create',
            resource_type: 'agent',
            resource_id: createdAgent.id,
            change_summary: {
              agent_id: createdAgent.id,
              agent_nome: createdAgent.nome,
              seed_profile_version_id: seedProfile.id,
              seed_profile_version: seedProfile.version,
              seed_profile_status: seedProfile.status,
              proposed_reason: args.seed_profile.proposed_reason,
            },
          });
          insertedAuditIdx.push(audit.length - 1);
          return { agent: createdAgent, seed_profile: seedProfile };
        } catch (err) {
          // ROLLBACK: undo every write made above. This is the invariant the
          // test asserts — if audit throws, agent + profile_version DO NOT
          // persist.
          if (agentsMap[insertedAgentId]) delete agentsMap[insertedAgentId];
          for (const pid of insertedProfileIds) {
            const idx = profiles.findIndex((p) => p.id === pid);
            if (idx >= 0) profiles.splice(idx, 1);
          }
          for (const aidx of insertedAuditIdx.slice().reverse()) {
            audit.splice(aidx, 1);
          }
          throw err;
        }
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
      // Atomic propose+audit. Mock emulates `withTx` rollback: if the audit
      // insert throws, the profile_version row inserted earlier is removed.
      async proposeAndAuditAtomic(args: {
        tenant_id: string;
        agent_id: string;
        profile_body: unknown;
        proposed_by: string;
        proposed_reason: string;
        previous_active_id: string | null;
        actor_id: string;
        actor_role: string;
      }) {
        const insertedProfileIds: string[] = [];
        try {
          const version =
            profiles.filter(
              (p) => p.tenant_id === args.tenant_id && p.agent_id === args.agent_id,
            ).length + 1;
          const row: Profile = {
            id: `prof-${profiles.length + 1}`,
            tenant_id: args.tenant_id,
            agent_id: args.agent_id,
            version,
            status: 'proposed',
            profile_body: args.profile_body,
            proposed_by: args.proposed_by,
            proposed_reason: args.proposed_reason,
          };
          profiles.push(row);
          insertedProfileIds.push(row.id);

          if (opts.failAuditOnAction === 'agent_profile_propose') {
            throw new Error('simulated audit insert failure');
          }
          audit.push({
            tenant_id: args.tenant_id,
            actor_id: args.actor_id,
            actor_role: args.actor_role,
            action: 'agent_profile_propose',
            resource_type: 'agent_operational_profile_version',
            resource_id: row.id,
            change_summary: {
              agent_id: args.agent_id,
              previous_version_id: args.previous_active_id,
              new_version: row.version,
              status: row.status,
              proposed_reason: args.proposed_reason,
            },
          });
          return { version: row, previous_version_id: args.previous_active_id };
        } catch (err) {
          for (const pid of insertedProfileIds) {
            const idx = profiles.findIndex((p) => p.id === pid);
            if (idx >= 0) profiles.splice(idx, 1);
          }
          throw err;
        }
      },
      // Mirrors the tx-aware repo path: finds the target proposed row, freezes
      // any incumbent active for the same (tenant, agent), activates the new
      // one, audits — all "atomically" in mock-land (just runs synchronously).
      //
      // Codex Adversarial Review of PR #171 round 2 — also mirrors the new
      // predecessor enforcement: reads
      // `profile_body.metadata.previous_version_id` from the proposed row and
      // rejects with `predecessor_conflict` when it doesn't match the current
      // incumbent.
      //
      // Codex Adversarial Review of PR #171 round 3 — also mirrors:
      //   - parent-agent existence check (returns `agent_missing` if the
      //     agent was deleted between findById and the lock acquisition);
      //   - migrated-legacy detection (`metadata.migrated_from_legacy === true`
      //     + explicit null predecessor → `migrated_legacy_proposal`);
      //   - intentional-seed exception (`version === 1` + no incumbent +
      //     explicit null predecessor → accept).
      async approveAndActivateAtomic(args: {
        tenant_id: string;
        agent_id: string;
        id: string;
        actor_id: string;
        actor_role: string;
        comment: string;
      }) {
        // Mirror the parent-agent FOR UPDATE lock — if the agent row was
        // deleted between the router's findById and the tx lock, surface
        // the typed-miss instead of falling through to predecessor checks.
        if (!agentsMap[args.agent_id] || agentsMap[args.agent_id]!.tenant_id !== args.tenant_id) {
          return { ok: false as const, reason: 'agent_missing' as const };
        }
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

        // Predecessor enforcement (mirrors repo behavior).
        const md = (target.profile_body as { metadata?: Record<string, unknown> } | null)
          ?.metadata;
        let expected: string | null | 'unknown';
        if (!md || !('previous_version_id' in md)) {
          expected = 'unknown';
        } else {
          const v = md.previous_version_id;
          expected = v === null ? null : typeof v === 'string' ? v : 'unknown';
        }
        const current = incumbent?.id ?? null;
        if (expected === 'unknown') {
          return {
            ok: false as const,
            reason: 'predecessor_conflict' as const,
            expected: 'unknown' as const,
            current,
          };
        }

        // Round 3 #173: migrated legacy rejected with distinct sentinel.
        const isMigrated = md?.migrated_from_legacy === true;
        if (expected === null && isMigrated) {
          return {
            ok: false as const,
            reason: 'migrated_legacy_proposal' as const,
            expected: null,
            current,
          };
        }

        // Round 3 #173: intentional seed (v1 + no incumbent + null predecessor).
        const isIntentionalSeed = expected === null && current === null && target.version === 1;

        // Codex Adversarial Review of PR #182 round 3 (#186): explicit
        // `null` predecessor on any non-seed proposal must be rejected with
        // the new `missing_predecessor` typed reason. Mirrors the repo.
        if (!isIntentionalSeed && expected === null) {
          return {
            ok: false as const,
            reason: 'missing_predecessor' as const,
            proposed_version: target.version,
            current_predecessor: current,
          };
        }

        if (!isIntentionalSeed && expected !== current) {
          return {
            ok: false as const,
            reason: 'predecessor_conflict' as const,
            expected,
            current,
          };
        }

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
            expected_predecessor_id: expected,
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

  // Codex round 2: proposals authored under the new flow carry
  // `metadata.previous_version_id` so `approveAndActivateAtomic` can detect
  // write-skew. Helpers to build well-formed profile_body for these tests.
  const bodyWithPrev = (prev: string | null) => ({
    metadata: { previous_version_id: prev },
  });

  it.each(['analyst', 'viewer', 'compliance_officer'])(
    '%s cannot approve',
    async (role) => {
      const proposed: Profile = {
        id: '00000000-0000-4000-8000-0000000000a1',
        tenant_id: 'tenant-A',
        agent_id: 'agent-x',
        version: 1,
        status: 'proposed',
        profile_body: bodyWithPrev(null),
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
      profile_body: bodyWithPrev(null),
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
    expect(repos._inspect.audit[0]!.change_summary?.expected_predecessor_id).toBeNull();
  });

  it('owner approves v2 while v1 active → v1 frozen, v2 active, audited atomically', async () => {
    const v1Active: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: bodyWithPrev(null),
      proposed_by: 'system',
      proposed_reason: null,
    };
    const v2Proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 2,
      status: 'proposed',
      // v2 was proposed against v1 — predecessor matches incumbent.
      profile_body: bodyWithPrev('00000000-0000-4000-8000-0000000000a1'),
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
    // Audit records both sides of the swap + the predecessor expectation.
    const audit = repos._inspect.audit[0]!;
    expect(audit.change_summary?.previous_active_id).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(audit.change_summary?.new_version_id).toBe('00000000-0000-4000-8000-0000000000a2');
    expect(audit.change_summary?.expected_predecessor_id).toBe('00000000-0000-4000-8000-0000000000a1');
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
      profile_body: bodyWithPrev(null),
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

  /**
   * Codex Adversarial Review of PR #171 round 2 — predecessor enforcement.
   *
   * Sequencial scenario: v1 active, owner Bob proposes v2 (predecessor=v1)
   * and Alice proposes v3 (predecessor=v1). Bob's v2 gets approved first
   * → v1 frozen, v2 active. If Alice's v3 is approved next without
   * predecessor enforcement, v2 would be silently frozen and v3 would
   * become active even though its content was written against v1 — Alice
   * had no chance to incorporate Bob's changes.
   *
   * The fix: approving v3 must detect the mismatch (expected: v1, current:
   * v2) and reject with CONFLICT so Alice refreshes and re-proposes
   * against v2.
   */
  it('predecessor_conflict: v3 (proposed against v1) is rejected after v2 was approved', async () => {
    const v1Active: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: bodyWithPrev(null),
      proposed_by: 'system',
      proposed_reason: null,
    };
    const v2Proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 2,
      status: 'proposed',
      profile_body: bodyWithPrev('00000000-0000-4000-8000-0000000000a1'),
      proposed_by: 'bob',
      proposed_reason: 'bob update',
    };
    const v3Proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a3',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 3,
      status: 'proposed',
      // Alice's v3 was authored against v1 too — she didn't see Bob's v2.
      profile_body: bodyWithPrev('00000000-0000-4000-8000-0000000000a1'),
      proposed_by: 'alice',
      proposed_reason: 'alice update',
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [v1Active, v2Proposed, v3Proposed],
    });

    // Step 1: Bob's v2 is approved successfully — v1 → frozen, v2 → active.
    const approveV2 = await caller('owner', 'tenant-A', 'u1', repos).approveProfile({
      agentId: 'agent-x',
      versionId: '00000000-0000-4000-8000-0000000000a2',
      comment: 'approve bob v2',
    });
    expect(approveV2.activated.id).toBe('00000000-0000-4000-8000-0000000000a2');
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a2')!
        .status,
    ).toBe('active');

    // Step 2: Alice's v3 was proposed against v1, but v2 is now active.
    // Approving v3 must be rejected with CONFLICT — otherwise Bob's v2
    // would be silently overwritten.
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a3',
        comment: 'approve alice v3',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/active profile changed/i),
    });

    // v2 must STILL be active, v3 must STILL be proposed — the rejected
    // approval did not corrupt the lineage.
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a2')!
        .status,
    ).toBe('active');
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a3')!
        .status,
    ).toBe('proposed');
  });

  it('predecessor_conflict (legacy): proposal without metadata.previous_version_id is rejected', async () => {
    const proposed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'proposed',
      // No metadata — pretends to be a legacy proposal authored before
      // this codepath existed. Policy: reject conservatively.
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [proposed] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'legacy proposal approval attempt',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/expected predecessor unknown/i),
    });
    // Profile MUST still be proposed — nothing was activated.
    expect(repos._inspect.profiles[0]!.status).toBe('proposed');
  });

  /**
   * Codex Adversarial Review of PR #171 round 3 ([high] #173) — migration 061
   * backfilled `metadata.previous_version_id = null` + `migrated_from_legacy:
   * true` for every legacy row. Without the discriminator, the predecessor
   * check accepted explicit `null` as "no predecessor expected" (valid for
   * intentional seed v1), so a stale migrated proposal whose true lineage
   * is unknowable could silently activate against an empty active slot.
   * The new policy rejects migrated proposals with a distinct sentinel.
   */
  it('migrated_legacy_proposal: explicit null + migrated_from_legacy marker is rejected', async () => {
    const migrated: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      // Could be any version — migration 061 backfilled all of them.
      version: 1,
      status: 'proposed',
      profile_body: {
        metadata: {
          previous_version_id: null,
          migrated_from_legacy: true,
        },
      },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [migrated] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'attempt to approve a migrated legacy proposal',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/v3\.1\.1 legacy backfill/i),
    });
    // Profile MUST still be proposed — nothing was activated.
    expect(repos._inspect.profiles[0]!.status).toBe('proposed');
    // No audit row appended — the rejection happened before the audit step.
    expect(repos._inspect.audit).toHaveLength(0);
  });

  /**
   * Codex Adversarial Review of PR #171 round 3 — the intentional-seed
   * exception accepts explicit `null` predecessor ONLY when (a) there's no
   * incumbent active row AND (b) this is version 1. Any non-seed null case
   * (v2+ with null, or v1 with an incumbent) falls through to
   * predecessor_conflict. Matches the `create → approve` seed flow shipped
   * with `createWithSeedAndAudit`.
   */
  it('intentional seed: v1 + no incumbent + null predecessor (no marker) is approved', async () => {
    const seed: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'proposed',
      profile_body: { metadata: { previous_version_id: null } },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [seed] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).approveProfile({
      agentId: 'agent-x',
      versionId: '00000000-0000-4000-8000-0000000000a1',
      comment: 'first activation for this agent',
    });
    expect(res.activated.id).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(res.frozen_previous).toBeNull();
    expect(repos._inspect.profiles[0]!.status).toBe('active');
  });

  /**
   * Codex Adversarial Review of PR #182 round 3 (#186) — the dangerous
   * shape that was missed in round 3 of PR #171: explicit `null`
   * predecessor on v2+ with NO incumbent active row. The round-3
   * intentional-seed gate only fired for v === 1, so v2+ + null + null
   * structurally satisfied the equality check (`null === null`) and got
   * activated with no lineage anchor. That bypasses the stale-predecessor
   * guard and can reactivate profile state after rollback without binding
   * to the last known version.
   *
   * The new policy: any non-seed proposal with `previous_version_id: null`
   * is REJECTED as missing_predecessor (PRECONDITION_FAILED).
   */
  it('missing_predecessor: v2 + no incumbent + null predecessor is REJECTED (was bypass in PR #181)', async () => {
    const v2NoIncumbent: Profile = {
      id: '00000000-0000-4000-8000-0000000000a2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 2,
      status: 'proposed',
      profile_body: { metadata: { previous_version_id: null } },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [v2NoIncumbent] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a2',
        comment: 'approve v2 against empty active slot — should be rejected',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/has no predecessor lineage/i),
    });
    // Profile MUST still be proposed — nothing was activated.
    expect(repos._inspect.profiles[0]!.status).toBe('proposed');
  });

  it('missing_predecessor: v1 + incumbent + null predecessor is REJECTED', async () => {
    // v1 cannot coexist with an active incumbent. Reject as
    // missing_predecessor rather than predecessor_conflict so the
    // operator sees the right diagnosis.
    const v1Active: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: bodyWithPrev(null),
      proposed_by: 'system',
      proposed_reason: null,
    };
    const v1Extra: Profile = {
      id: '00000000-0000-4000-8000-0000000000b1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'proposed',
      profile_body: { metadata: { previous_version_id: null } },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [v1Active, v1Extra] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000b1',
        comment: 'v1 + incumbent + null pred — should be rejected',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/has no predecessor lineage/i),
    });
    // Both rows untouched.
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a1')!.status,
    ).toBe('active');
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000b1')!.status,
    ).toBe('proposed');
  });

  it('missing_predecessor: v2 + incumbent + null predecessor is REJECTED (was predecessor_conflict in round 2)', async () => {
    // Round 2's check (`expected !== current`) caught this too. We now
    // surface a clearer reason: the proposal is missing its predecessor,
    // not that someone changed the incumbent under it.
    const v1Active: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: bodyWithPrev(null),
      proposed_by: 'system',
      proposed_reason: null,
    };
    const v2NullPred: Profile = {
      id: '00000000-0000-4000-8000-0000000000a2',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 2,
      status: 'proposed',
      profile_body: { metadata: { previous_version_id: null } },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [v1Active, v2NullPred] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a2',
        comment: 'v2 null pred with v1 active — should be rejected',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/has no predecessor lineage/i),
    });
    // v1 still active, v2 still proposed.
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a1')!.status,
    ).toBe('active');
    expect(
      repos._inspect.profiles.find((p) => p.id === '00000000-0000-4000-8000-0000000000a2')!.status,
    ).toBe('proposed');
  });

  it('migrated_legacy_proposal precedence: null + marker still rejected as migrated (not missing_predecessor)', async () => {
    // The migrated-legacy check fires BEFORE the null-predecessor check
    // (so the operator sees the most specific diagnosis). v2+ with
    // migrated_from_legacy marker + null predecessor → migrated_legacy_proposal,
    // not missing_predecessor.
    const migrated: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 5, // any non-v1 version
      status: 'proposed',
      profile_body: {
        metadata: {
          previous_version_id: null,
          migrated_from_legacy: true,
        },
      },
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [migrated] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-x',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'migrated v5 with null pred — should be rejected as migrated',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/v3\.1\.1 legacy backfill/i),
    });
    // Not a PRECONDITION_FAILED with missing_predecessor message.
    expect(repos._inspect.profiles[0]!.status).toBe('proposed');
  });

  /**
   * Codex Adversarial Review of PR #171 round 3 — `agent_missing` typed-miss
   * surfaces as NOT_FOUND. Simulates the agent being deleted between the
   * router's findById check and the parent-agent FOR UPDATE lock inside
   * the tx (mock checks agentsMap[args.agent_id] presence to mirror).
   */
  it('NOT_FOUND when parent agent vanished between findById and lock', async () => {
    // No agent in the map — but a proposal exists pointing at it. In real
    // life this is the (rare) race where the agent was deleted after the
    // router's findById succeeded but before the FOR UPDATE lock fired.
    const orphanProposal: Profile = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-deleted',
      version: 1,
      status: 'proposed',
      profile_body: { metadata: { previous_version_id: null } },
      proposed_by: 'system',
      proposed_reason: null,
    };
    // Pre-populate with the agent so router.findById succeeds, then we
    // delete it right before calling. The mock's approveAndActivateAtomic
    // re-checks agentsMap so the typed-miss fires correctly.
    const agent: Agent = {
      id: 'agent-deleted',
      tenant_id: 'tenant-A',
      nome: 'about to vanish',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const repos = makeRepos({ agents: [agent], profiles: [orphanProposal] });
    // Vanish the agent before approve (simulates the race).
    delete repos._inspect.agentsMap['agent-deleted'];
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).approveProfile({
        agentId: 'agent-deleted',
        versionId: '00000000-0000-4000-8000-0000000000a1',
        comment: 'race against agent deletion',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * ATOMICITY (issue #166) — the agentsRouter must not commit a partial
 * create/updateProfile sequence. If the audit insert throws (sim. via the
 * `failAuditOnAction` knob, which the mock honors by rolling back earlier
 * inserts in the same logical tx), neither the agent row nor the seed/new
 * profile_version row may persist.
 *
 * These tests exercise the contract of `agentsRepo.createWithSeedAndAudit`
 * and `operationalProfileVersionsRepo.proposeAndAuditAtomic` from the router's
 * perspective — the real repo wraps the writes in `withTx` so a Postgres
 * exception triggers ROLLBACK at the DB level.
 */
describe('agentsRouter — multi-write atomicity (#166)', () => {
  it('create: audit failure rolls back agent + seed profile_version', async () => {
    const repos = makeRepos({ failAuditOnAction: 'agent_create' });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: validProfile,
        proposed_reason: 'seed that should rollback when audit fails',
      }),
    ).rejects.toThrow(/simulated audit insert failure/);

    // Neither the agent row nor the seed profile_version was persisted.
    expect(repos._inspect.agentsMap['agent-x']).toBeUndefined();
    expect(repos._inspect.profiles.find((p) => p.agent_id === 'agent-x')).toBeUndefined();
    // And no audit row was appended (would be a forensics ghost otherwise).
    expect(repos._inspect.audit).toHaveLength(0);
  });

  it('create: happy path persists all three rows', async () => {
    const repos = makeRepos();
    const res = await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfile,
      proposed_reason: 'happy-path baseline for the rollback test above',
    });
    expect(res.agent.id).toBe('agent-x');
    expect(repos._inspect.agentsMap['agent-x']).toBeDefined();
    expect(repos._inspect.profiles).toHaveLength(1);
    expect(repos._inspect.audit).toHaveLength(1);
    expect(repos._inspect.audit[0]!.action).toBe('agent_create');
  });

  it('updateProfile: audit failure rolls back the new profile_version', async () => {
    const existingAgent: Agent = {
      id: 'agent-x',
      tenant_id: 'tenant-A',
      nome: 'X',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const v1Active: Profile = {
      id: 'prof-v1',
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
      profiles: [v1Active],
      failAuditOnAction: 'agent_profile_propose',
    });

    await expect(
      caller('owner', 'tenant-A', 'u1', repos).updateProfile({
        agentId: 'agent-x',
        profile_body: validProfile,
        proposed_reason: 'update that should rollback when audit fails',
      }),
    ).rejects.toThrow(/simulated audit insert failure/);

    // Only the pre-existing v1 active row remains; the proposed v2 did NOT
    // persist, even though it was inserted before the audit threw.
    expect(repos._inspect.profiles).toHaveLength(1);
    expect(repos._inspect.profiles[0]!.id).toBe('prof-v1');
    expect(repos._inspect.profiles[0]!.status).toBe('active');
    // No audit row was appended.
    expect(repos._inspect.audit).toHaveLength(0);
  });

  it('updateProfile: happy path persists v2 proposed + audit row', async () => {
    const existingAgent: Agent = {
      id: 'agent-x',
      tenant_id: 'tenant-A',
      nome: 'X',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const v1Active: Profile = {
      id: 'prof-v1',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {},
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({ agents: [existingAgent], profiles: [v1Active] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile,
      proposed_reason: 'happy-path baseline for the rollback test above',
    });
    expect(res.version.status).toBe('proposed');
    expect(res.previous_version_id).toBe('prof-v1');
    expect(repos._inspect.profiles).toHaveLength(2);
    expect(repos._inspect.audit).toHaveLength(1);
    expect(repos._inspect.audit[0]!.action).toBe('agent_profile_propose');
  });
});
