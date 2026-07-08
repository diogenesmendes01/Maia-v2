/**
 * Admin UI Setup — agentsRouter unit tests.
 *
 * Drives the router through tRPC's caller with in-memory repos. Verifies:
 *   1. create requires role founder|owner; viewer/analyst/compliance get FORBIDDEN.
 *   2. create writes the agent row AND seeds an operational_profile_version
 *      with status='proposed' AND appends an audit row — ATOMICALLY (via
 *      agentsRepo.createWithSeedAndAudit; issue #166).
 *   3. create against a non-existent tenant returns NOT_FOUND.
 *   4. create with a duplicate agent id returns CONFLICT (typed duplicate_id
 *      from the atomic helper — issue #184 follow-up on PR #187 round 1).
 *   5. updateProfile chains previous_version_id from the active version.
 *   6. updateProfile on a foreign-tenant agent returns NOT_FOUND (tenant
 *      isolation invariant).
 *   7. resolveTenantId still rejects a body-supplied tenant for non-founder.
 *   8. ATOMICITY (issue #166): if the audit insert throws inside
 *      createWithSeedAndAudit / proposeAndAuditAtomic, neither the agent row
 *      nor the profile_version row are persisted (full rollback).
 *   9. ATOMICITY (issue #184 round 1): a simulated pg 23505 thrown from the
 *      agent INSERT inside createWithSeedAndAudit is caught and surfaced as
 *      typed duplicate_id — the router maps it to CONFLICT without leaking
 *      a 500. Closes the TOCTOU window left by the removed findById preflight.
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
  /** Optional in fixtures; listByStatus fills a fallback when absent. */
  created_at?: Date;
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
 *   - simulateAgentPkConflict: when true, the mock simulates a Postgres
 *     23505 (unique_violation) thrown at the moment of the agent INSERT
 *     inside createWithSeedAndAudit (mirroring the concurrent-create race
 *     where two callers both passed the now-removed router preflight and
 *     one loses the agents PK contest). The atomic helper must catch this
 *     and return `{ ok: false, reason: 'duplicate_id' }` instead of letting
 *     the raw pg error leak as a 500 — closes the TOCTOU window flagged
 *     by Codex Adversarial Review on PR #187 round 1 (issue #184).
 */
function makeRepos(
  opts: {
    tenants?: string[];
    agents?: Agent[];
    profiles?: Profile[];
    failAuditOnAction?: 'agent_create' | 'agent_profile_propose';
    simulateAgentPkConflict?: boolean;
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
      //
      // Returns a discriminated union `{ ok: true, ... } | { ok: false,
      // reason: 'duplicate_id', agent_id }` so the router can map the
      // concurrent-create race to CONFLICT without inspecting pg error codes
      // (Codex Adversarial Review on PR #187 round 1 / issue #184).
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
        // (0) Duplicate-id contract: the real method relies on the PRIMARY
        //     KEY constraint to surface 23505 from the agent INSERT, which
        //     we translate to a typed reason. Mirror that in the mock so the
        //     router sees the same contract on conflict whether the racer
        //     had committed before this call started OR raced inside the tx
        //     (`simulateAgentPkConflict` covers the latter).
        if (agentsMap[args.agent.id] || opts.simulateAgentPkConflict) {
          // Tx rollback is implicit — we never inserted anything in this
          // call. Audit row never appended (loser of the race produces no
          // forensics ghost).
          return {
            ok: false as const,
            reason: 'duplicate_id' as const,
            agent_id: args.agent.id,
          };
        }

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
          return {
            ok: true as const,
            agent: createdAgent,
            seed_profile: seedProfile,
          };
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
      // Unlike getActive above, this one DOES read the real AsyncLocalStorage:
      // the router wraps the call in runWithTenantContext, so the store is
      // populated by the time the mock runs. pendingProfileApprovals fans out
      // per agent and would double-count without the (tenant, agent) scope.
      async listByStatus(status: string) {
        const { getCurrentTenant, getCurrentAgent } = await import(
          '@/db/tenant-context.js'
        );
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        return profiles
          .filter(
            (p) =>
              p.status === status &&
              p.tenant_id === tenant_id &&
              p.agent_id === agent_id,
          )
          .map((p) => ({ ...p, created_at: p.created_at ?? new Date() }));
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

const validProfileWithPrinciples = {
  identity: {
    role_descriptor: 'assistente fiscal',
    voice: { tone: 'profissional', formality: 'medium', verbosity: 'medium' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['precisao', 'clareza'],
    principles: [
      'Separação acima de tudo. PF é PF.',
      'Confirme antes de agir em coisas relevantes.',
    ],
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

/**
 * Codex Adversarial Review on PR #187 round 1 ([medium], issue #184).
 *
 * Pre-fix: agentsRouter.create relied on an out-of-tx `findById` preflight to
 * decide whether to throw CONFLICT. Two concurrent creates with the same id
 * could both pass that check; the loser of the agents PK race then had its
 * raw pg `23505` bubble up as INTERNAL_SERVER_ERROR (500), forcing the UI
 * and retry logic onto an unhappy path despite the new atomic helper.
 *
 * Post-fix: `createWithSeedAndAudit` catches PK 23505 inside the tx and
 * returns `{ ok: false, reason: 'duplicate_id', agent_id }`. The router maps
 * that to TRPC CONFLICT and the pre-flight `findById` is removed (the atomic
 * helper now is the single source of truth on duplicate ids — no TOCTOU
 * window to leak through). These tests cover BOTH ordering windows that
 * produce duplicate_id:
 *
 *   - A duplicate already committed BEFORE the call (mock: id present in
 *     agentsMap at entry — same path as the pre-fix preflight covered).
 *   - A duplicate committed AFTER we entered the tx but BEFORE our INSERT
 *     landed (mock: `simulateAgentPkConflict` — the previously-uncovered
 *     concurrent-create race that leaked 500).
 *
 * Both must surface as CONFLICT with no orphaned writes.
 */
describe('agentsRouter.create — duplicate_id from atomic helper (issue #184 round 1)', () => {
  it('router maps duplicate_id (pre-existing agent) to CONFLICT with agent_id in message', async () => {
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
        proposed_reason: 'concurrent-create attempt against pre-existing id',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/agent-x.*already exists/i),
    });

    // The pre-existing row is untouched (no overwrite), no seed_profile
    // was created for the duplicate, no audit row was appended for the
    // loser. The atomic helper's rollback contract is preserved.
    expect(repos._inspect.agentsMap['agent-x']!.nome).toBe('old');
    expect(repos._inspect.profiles).toHaveLength(0);
    expect(repos._inspect.audit).toHaveLength(0);
  });

  it('router maps duplicate_id (simulated tx-internal 23505) to CONFLICT', async () => {
    // No pre-existing agent — the conflict happens INSIDE the tx, as if a
    // racer committed between our (now-removed) preflight and our INSERT.
    // This is the case the fix specifically addresses: pre-fix, this would
    // have leaked as INTERNAL_SERVER_ERROR.
    const repos = makeRepos({ simulateAgentPkConflict: true });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'racer',
        profile_body: validProfile,
        proposed_reason: 'losing the in-tx 23505 race against a concurrent create',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/agent-x.*already exists/i),
    });

    // Tx rolled back: no seed_profile, no audit row, no agent inserted by
    // the loser (the winner's row, if any, is the racer's — not modeled in
    // the mock, but the loser MUST contribute nothing to the inspect state).
    expect(repos._inspect.agentsMap['agent-x']).toBeUndefined();
    expect(repos._inspect.profiles).toHaveLength(0);
    expect(repos._inspect.audit).toHaveLength(0);
  });

  it('atomic helper returns typed duplicate_id (not throws) for pre-existing id', async () => {
    // Exercises the repo-method contract directly, bypassing the router so
    // we assert the discriminated-union shape rather than the TRPC mapping.
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
    const result = await repos.agentsRepo.createWithSeedAndAudit({
      agent: {
        id: 'agent-x',
        tenant_id: 'tenant-A',
        nome: 'new',
      },
      seed_profile: {
        profile_body: validProfile,
        proposed_by: 'u1',
        proposed_reason: 'direct repo call — duplicate id',
      },
      audit: { actor_id: 'u1', actor_role: 'owner' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('duplicate_id');
      expect(result.agent_id).toBe('agent-x');
    }
  });

  it('atomic helper returns typed duplicate_id (not throws) for simulated 23505', async () => {
    const repos = makeRepos({ simulateAgentPkConflict: true });
    const result = await repos.agentsRepo.createWithSeedAndAudit({
      agent: {
        id: 'agent-x',
        tenant_id: 'tenant-A',
        nome: 'racer',
      },
      seed_profile: {
        profile_body: validProfile,
        proposed_by: 'u1',
        proposed_reason: 'direct repo call — simulated tx-internal 23505',
      },
      audit: { actor_id: 'u1', actor_role: 'owner' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('duplicate_id');
      expect(result.agent_id).toBe('agent-x');
    }
  });

  it('happy path still returns { ok: true, agent, seed_profile } (discriminated union unchanged for success)', async () => {
    // Regression guard: the router must keep working when there is no
    // duplicate. The discriminated-union refactor should be invisible to
    // the success branch — the response shape from the router is the same
    // as before (`{ agent, seed_profile: { id, version, status } }`).
    const repos = makeRepos();
    const res = await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfile,
      proposed_reason: 'happy-path baseline after discriminated-union refactor',
    });
    expect(res.agent.id).toBe('agent-x');
    expect(res.seed_profile.version).toBe(1);
    expect(res.seed_profile.status).toBe('proposed');
  });
});

/**
 * Issue #193 — distinct identity.principles field.
 *
 * Bug: admin-ui setup accepted role, voice, cognitive_limits and priorities
 * but had NO distinct input for `principles`. The post-#189 valoresDetector
 * refuses to treat priorities as principles and silently returns null when no
 * true principles are configured, so every admin-created profile shipped with
 * the VALORES guardrail disabled. Operators putting "core value" text into the
 * priorities textarea (or who simply didn't realize principles existed as a
 * separate concept) had core-value violations go un-frozen.
 *
 * Fix contract (these tests are the gate):
 *   1. The router input schema accepts `identity.principles: string[]` (with
 *      the same per-item bounds as priorities).
 *   2. `buildProfileBody` persists them at `profile_body.identity.principles`
 *      so the legacy resolver — which already reads
 *      `body.identity.principles` — surfaces them to valoresDetector. The
 *      audited profile_body that landed in the seed proposal is the assertion
 *      target.
 *   3. principles is optional (missing → no principles, matches current
 *      behavior — VALORES skipped, no auto-freeze for that profile).
 *   4. priorities are NEVER auto-copied into principles. Submitting only
 *      priorities still yields `principles === []` (or undefined) in the
 *      persisted body. This is the explicit anti-pattern that #189/#191 closed
 *      and the resolver/detector contract depends on.
 */
describe('agentsRouter — identity.principles field (#193)', () => {
  it('create: principles persist into profile_body.identity.principles', async () => {
    const repos = makeRepos();
    await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfileWithPrinciples,
      proposed_reason: 'seed agent with explicit core principles',
    });
    const persisted = repos._inspect.profiles[0]!.profile_body as {
      identity?: { principles?: unknown[]; priorities?: unknown[] };
    };
    expect(persisted.identity?.principles).toEqual([
      'Separação acima de tudo. PF é PF.',
      'Confirme antes de agir em coisas relevantes.',
    ]);
    // priorities must remain distinct.
    expect(persisted.identity?.priorities).toEqual(['precisao', 'clareza']);
  });

  it('create: omitting principles persists empty principles (NO auto-copy from priorities)', async () => {
    // The exact anti-pattern #189/#191 forbids: priorities MUST NOT be silently
    // promoted to principles. A submission with only priorities yields a body
    // where principles is empty/missing, so valoresDetector correctly skips.
    const repos = makeRepos();
    await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfile,
      proposed_reason: 'priorities-only profile — VALORES must stay disabled',
    });
    const persisted = repos._inspect.profiles[0]!.profile_body as {
      identity?: { principles?: unknown[]; priorities?: unknown[] };
    };
    expect(persisted.identity?.priorities).toEqual(['precisao', 'clareza']);
    // principles is either an empty array OR undefined — both are honored by
    // the resolver as "no true principles configured" (length === 0 branch).
    expect(persisted.identity?.principles ?? []).toEqual([]);
  });

  it('updateProfile: principles persist into profile_body.identity.principles', async () => {
    const existingAgent: Agent = {
      id: 'agent-x',
      tenant_id: 'tenant-A',
      nome: 'X',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const repos = makeRepos({ agents: [existingAgent] });
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfileWithPrinciples,
      proposed_reason: 'update with explicit core principles',
    });
    // The new v1 proposed row carries the principles in profile_body.identity.
    const persisted = repos._inspect.profiles[0]!.profile_body as {
      identity?: { principles?: unknown[] };
    };
    expect(persisted.identity?.principles).toEqual([
      'Separação acima de tudo. PF é PF.',
      'Confirme antes de agir em coisas relevantes.',
    ]);
  });

  /**
   * Cross-module regression: a profile body persisted by the router with
   * explicit principles is audited by valoresDetector (it issues a real
   * LLM call). A profile body with priorities-only IS NOT audited
   * (detector short-circuits with `no_principles_configured`).
   *
   * Uses resolveLegacyPayload directly to assert the contract at the
   * resolver boundary — that's exactly what valoresDetector consumes.
   * Avoids the Anthropic mock plumbing in the router spec.
   */
  it('VALORES contract: persisted body with principles is auditable; priorities-only is not', async () => {
    // Lazy require so we don't pollute test imports for unrelated cases.
    type Persisted = { identity?: { principles?: unknown[] } };
    const { resolveLegacyPayload } =
      await import('@/identity/profile-legacy-resolver.js');

    // (1) With principles configured — resolver surfaces them.
    const reposWith = makeRepos();
    await caller('owner', 'tenant-A', 'u1', reposWith).create({
      id: 'agent-with',
      nome: 'With',
      profile_body: validProfileWithPrinciples,
      proposed_reason: 'principles seeded — valores detector active',
    });
    const bodyWith = reposWith._inspect.profiles[0]!.profile_body as Persisted;
    const resolvedWith = resolveLegacyPayload({ profile_body: bodyWith });
    const principlesWith = Array.isArray(resolvedWith.core_immutable.principles)
      ? resolvedWith.core_immutable.principles.filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0,
        )
      : [];
    expect(principlesWith.length).toBeGreaterThan(0);

    // (2) priorities-only — resolver MUST NOT synthesize principles from
    //     priorities. valoresDetector will short-circuit (length === 0).
    const reposOnly = makeRepos();
    await caller('owner', 'tenant-A', 'u1', reposOnly).create({
      id: 'agent-only',
      nome: 'Only',
      profile_body: validProfile,
      proposed_reason: 'priorities-only — valores detector must skip',
    });
    const bodyOnly = reposOnly._inspect.profiles[0]!.profile_body as Persisted;
    const resolvedOnly = resolveLegacyPayload({ profile_body: bodyOnly });
    const principlesOnly = Array.isArray(resolvedOnly.core_immutable.principles)
      ? resolvedOnly.core_immutable.principles.filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0,
        )
      : [];
    expect(principlesOnly).toEqual([]);
  });

  it('input schema: principles items have same per-item bounds as priorities (rejects empty / overlong)', async () => {
    const repos = makeRepos();
    // Empty string item is invalid.
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: {
          ...validProfile,
          identity: { ...validProfile.identity, principles: [''] },
        },
        proposed_reason: 'should reject empty principle item',
      }),
    ).rejects.toThrow();

    // Overlong item is invalid (priorities cap is 200 chars; mirror).
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-y',
        nome: 'Y',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            principles: ['x'.repeat(201)],
          },
        },
        proposed_reason: 'should reject overlong principle item',
      }),
    ).rejects.toThrow();
  });
});

/**
 * Codex Adversarial Review of PR #201 [HIGH] — cross-field overlap guard.
 *
 * Bug class: even with a distinct `principles` input (#193), a UI/API client
 * could submit the SAME operational labels in both `priorities` and
 * `principles`. The legacy resolver would surface them as core_immutable
 * principles → valoresDetector treats them as core value contracts → the
 * decision engine can freeze/rollback the profile for ordinary priority
 * drift. UI warnings are not a trust boundary; the router schema must reject
 * such submissions server-side.
 *
 * This is the same failure mode that #189/#191 closed at the resolver layer;
 * #201 round 2 closes the symmetric hole at the API ingress so no client
 * (legitimate or hostile) can re-introduce it.
 *
 * Contract:
 *   - Items are compared trimmed + case-insensitive.
 *   - ANY overlap between the two arrays is a rejection with a clear error
 *     pointing at the offending item.
 *   - The original strings are still persisted as supplied; only the
 *     comparison is normalized.
 *   - Applies to BOTH `create` AND `updateProfile` (same ProfileBodyInputSchema).
 */
describe('agentsRouter — priorities/principles overlap guard (#201 round 2)', () => {
  it('create: rejects exact duplicate between priorities and principles', async () => {
    const repos = makeRepos();
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: ['precisao', 'clareza'],
            // 'clareza' overlaps exactly with priorities.
            principles: ['Separação acima de tudo.', 'clareza'],
          },
        },
        proposed_reason: 'should reject — exact overlap between fields',
      }),
    ).rejects.toThrow(/clareza/i);
    // No agent / profile should have been persisted.
    expect(Object.keys(repos._inspect.agentsMap).length).toBe(0);
    expect(repos._inspect.profiles.length).toBe(0);
  });

  it('create: rejects case-insensitive overlap (Foo vs foo)', async () => {
    const repos = makeRepos();
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: ['Foo', 'bar'],
            // case-insensitive overlap with 'Foo'.
            principles: ['foo', 'baz'],
          },
        },
        proposed_reason: 'should reject — case-insensitive overlap',
      }),
    ).rejects.toThrow(/foo/i);
    expect(Object.keys(repos._inspect.agentsMap).length).toBe(0);
    expect(repos._inspect.profiles.length).toBe(0);
  });

  it('create: rejects whitespace-differing overlap ("foo " vs "foo")', async () => {
    const repos = makeRepos();
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: ['foo ', 'bar'],
            // trimmed overlap with priorities[0].
            principles: ['foo', 'baz'],
          },
        },
        proposed_reason: 'should reject — whitespace-differing overlap',
      }),
    ).rejects.toThrow(/foo/i);
    expect(Object.keys(repos._inspect.agentsMap).length).toBe(0);
    expect(repos._inspect.profiles.length).toBe(0);
  });

  it('create: accepts disjoint priorities and principles (regression)', async () => {
    const repos = makeRepos();
    const res = await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: validProfileWithPrinciples,
      proposed_reason: 'happy path — fields are disjoint',
    });
    expect(res.agent.id).toBe('agent-x');
    expect(res.seed_profile.status).toBe('proposed');
  });

  it('updateProfile: rejects exact duplicate between priorities and principles', async () => {
    const existingAgent: Agent = {
      id: 'agent-x',
      tenant_id: 'tenant-A',
      nome: 'X',
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const repos = makeRepos({ agents: [existingAgent] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).updateProfile({
        agentId: 'agent-x',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: ['precisao', 'clareza'],
            principles: ['Separação acima de tudo.', 'CLAREZA'],
          },
        },
        proposed_reason: 'should reject — overlap on updateProfile too',
      }),
    ).rejects.toThrow(/clareza/i);
    // No new profile row should have been persisted.
    expect(repos._inspect.profiles.length).toBe(0);
  });
});

/**
 * Codex Adversarial Review of PR #201 round 2 [HIGH] — VALORES guardrail
 * data-loss on omitted principles in updateProfile.
 *
 * Bug class: `updateProfile` rebuilds the next profile_body entirely from the
 * request. Because `identity.principles` is optional in
 * `ProfileBodyInputSchema`, an older client or a partial-edit caller that
 * updates the profile WITHOUT sending `principles` would propose a new
 * version with empty principles. Once approved, `valoresDetector` sees zero
 * configured principles and silently skips — disabling the hard value
 * guardrail for a profile that previously had it. Pure version-skew/data-loss
 * path introduced by adding an optional field to a full-replacement mutation.
 *
 * Fix contract (this PR round 2 follow-up):
 *   - On `updateProfile`: when `identity.principles` is OMITTED (undefined),
 *     preserve the active version's principles into the new proposed body.
 *   - When `identity.principles` is EXPLICITLY supplied as `[]`, it is an
 *     intentional audited clear — the proposed body carries `principles: []`.
 *   - When there is NO active version yet and principles is omitted, the
 *     proposed body's principles is `[]` (no source to preserve from).
 *   - When `identity.principles` is supplied non-empty, it replaces.
 *
 * `create` keeps the original semantics: omission means principles=[] (no
 * prior body to preserve from; the operator must declare principles
 * explicitly to enable VALORES).
 */
describe('agentsRouter.updateProfile — principles omission preserves active (#201 round 2)', () => {
  const existingAgent: Agent = {
    id: 'agent-x',
    tenant_id: 'tenant-A',
    nome: 'X',
    status: 'active',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('PRESERVE: omitted principles inherits from activeVersion.profile_body.identity.principles', async () => {
    // Active profile has principles configured (VALORES guardrail active).
    const activeWithPrinciples = {
      id: 'prof-active',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {
        identity: {
          priorities: ['precisao', 'clareza'],
          principles: [
            'Separação acima de tudo. PF é PF.',
            'Confirme antes de agir em coisas relevantes.',
          ],
        },
      } as unknown,
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [activeWithPrinciples],
    });
    // Update WITHOUT sending the principles key — legacy client / partial edit.
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile, // no `principles` key
      proposed_reason: 'change priorities; principles deliberately untouched',
    });
    // The new v2 proposed row MUST retain the existing principles.
    const proposed = repos._inspect.profiles.find((p) => p.status === 'proposed');
    expect(proposed).toBeDefined();
    const persisted = proposed!.profile_body as {
      identity?: { principles?: unknown[]; priorities?: unknown[] };
    };
    expect(persisted.identity?.principles).toEqual([
      'Separação acima de tudo. PF é PF.',
      'Confirme antes de agir em coisas relevantes.',
    ]);
    // priorities still updated from the request.
    expect(persisted.identity?.priorities).toEqual(['precisao', 'clareza']);
  });

  it('EXPLICIT CLEAR: explicit principles=[] persists empty (intentional audited clear)', async () => {
    // An operator explicitly clearing principles should still succeed; the
    // audit row carries the new body with principles=[] so the diff is
    // captured. This is the deliberate "I want VALORES disabled now" path.
    const activeWithPrinciples = {
      id: 'prof-active',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {
        identity: {
          priorities: ['precisao'],
          principles: ['Separação acima de tudo.'],
        },
      } as unknown,
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [activeWithPrinciples],
    });
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: {
        ...validProfile,
        identity: {
          ...validProfile.identity,
          principles: [], // explicit clear
        },
      },
      proposed_reason: 'intentionally remove principles — see ticket FOO-123',
    });
    const proposed = repos._inspect.profiles.find((p) => p.status === 'proposed');
    expect(proposed).toBeDefined();
    const persisted = proposed!.profile_body as {
      identity?: { principles?: unknown[] };
    };
    expect(persisted.identity?.principles).toEqual([]);
  });

  it('REPLACE: non-empty principles overwrites the active set', async () => {
    const activeWithPrinciples = {
      id: 'prof-active',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {
        identity: {
          priorities: ['precisao'],
          principles: ['old principle 1', 'old principle 2'],
        },
      } as unknown,
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [activeWithPrinciples],
    });
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfileWithPrinciples, // has its own principles
      proposed_reason: 'tighten principles for Q3',
    });
    const proposed = repos._inspect.profiles.find((p) => p.status === 'proposed');
    expect(proposed).toBeDefined();
    const persisted = proposed!.profile_body as {
      identity?: { principles?: unknown[] };
    };
    // From validProfileWithPrinciples — the request's principles win.
    expect(persisted.identity?.principles).toEqual([
      'Separação acima de tudo. PF é PF.',
      'Confirme antes de agir em coisas relevantes.',
    ]);
  });

  it('NO ACTIVE: omitted principles + no active version → empty (nothing to preserve)', async () => {
    // Agent exists but has no active profile (e.g., seed not yet approved).
    // Omitting principles should not synthesize them; we just have nothing
    // to inherit, so the proposed body's principles is [].
    const repos = makeRepos({ agents: [existingAgent] });
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile, // no `principles` key
      proposed_reason: 'first update against an unseeded agent',
    });
    const proposed = repos._inspect.profiles.find((p) => p.status === 'proposed');
    expect(proposed).toBeDefined();
    const persisted = proposed!.profile_body as {
      identity?: { principles?: unknown[] };
    };
    // No source to preserve from — principles is [] (matches old contract).
    expect(persisted.identity?.principles ?? []).toEqual([]);
  });

  it('REJECT: non-empty principles with empty priorities is refused at schema (#201 round 2 P2)', async () => {
    // Codex round 2 [P2] cross-PR interaction: IdentitySliceBuilder (P8a/P8d)
    // still falls back to `identity.principles` when `identity.priorities`
    // is empty (PR #200 is still pending merge). If a client submits
    // `priorities: []` + non-empty `principles`, the persisted body's
    // principles would be surfaced as priorities by the slice builder —
    // exactly the cross-domain contamination this PR's principles field
    // is trying to prevent.
    //
    // Defensive gate: refuse the combination at schema so the anti-pattern
    // is blocked at ingress, not at the resolver layer. When PR #200
    // (#192) merges the slice-builder fallback, this gate can be relaxed.
    const repos = makeRepos({ agents: [existingAgent] });
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).updateProfile({
        agentId: 'agent-x',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: [], // empty
            principles: ['Separação acima de tudo.'],
          },
        },
        proposed_reason: 'should reject — principles without priorities',
      }),
    ).rejects.toThrow(/priorities/i);
    // No new profile row should have been persisted.
    expect(repos._inspect.profiles.length).toBe(0);
  });

  it('REJECT: create with non-empty principles + empty priorities is also refused', async () => {
    const repos = makeRepos();
    await expect(
      caller('owner', 'tenant-A', 'u1', repos).create({
        id: 'agent-x',
        nome: 'X',
        profile_body: {
          ...validProfile,
          identity: {
            ...validProfile.identity,
            priorities: [],
            principles: ['Separação acima de tudo.'],
          },
        },
        proposed_reason: 'should reject — principles without priorities',
      }),
    ).rejects.toThrow(/priorities/i);
    expect(Object.keys(repos._inspect.agentsMap).length).toBe(0);
    expect(repos._inspect.profiles.length).toBe(0);
  });

  it('ACCEPT: empty priorities + empty/omitted principles is still allowed (no fallback risk)', async () => {
    // When BOTH are empty, there's no principles content to leak via the
    // slice-builder fallback — the gate must not over-trigger.
    const repos = makeRepos();
    const res = await caller('owner', 'tenant-A', 'u1', repos).create({
      id: 'agent-x',
      nome: 'X',
      profile_body: {
        ...validProfile,
        identity: {
          ...validProfile.identity,
          priorities: [],
          // principles omitted
        },
      },
      proposed_reason: 'no priorities and no principles — explicit blank',
    });
    expect(res.agent.id).toBe('agent-x');
    expect(res.seed_profile.status).toBe('proposed');
  });

  it('PRESERVE w/ malformed active: active.profile_body without identity.principles → empty (defensive)', async () => {
    // Defensive case: pre-#193 active rows may not have an `identity.principles`
    // key at all. Omission in the request must not blow up — it must yield
    // principles=[] (treated as "no source to preserve").
    const activeNoPrinciplesKey = {
      id: 'prof-active',
      tenant_id: 'tenant-A',
      agent_id: 'agent-x',
      version: 1,
      status: 'active',
      profile_body: {
        identity: {
          priorities: ['precisao'],
          // no `principles` key at all
        },
      } as unknown,
      proposed_by: 'system',
      proposed_reason: null,
    };
    const repos = makeRepos({
      agents: [existingAgent],
      profiles: [activeNoPrinciplesKey],
    });
    await caller('owner', 'tenant-A', 'u1', repos).updateProfile({
      agentId: 'agent-x',
      profile_body: validProfile, // no `principles` key
      proposed_reason: 'update against pre-#193 row',
    });
    const proposed = repos._inspect.profiles.find((p) => p.status === 'proposed');
    expect(proposed).toBeDefined();
    const persisted = proposed!.profile_body as {
      identity?: { principles?: unknown[] };
    };
    expect(persisted.identity?.principles ?? []).toEqual([]);
  });
});

describe('agentsRouter.pendingProfileApprovals', () => {
  const agentA: Agent = {
    id: 'agent-1',
    tenant_id: 'tenant-A',
    nome: 'Agente Um',
    status: 'active',
    metadata: {},
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
  };
  const agentB: Agent = { ...agentA, id: 'agent-2', nome: 'Agente Dois' };
  const agentC: Agent = { ...agentA, id: 'agent-3', nome: 'Agente Três' };

  it('aggregates proposed versions per agent, oldest-waiting first, skipping agents with none', async () => {
    const repos = makeRepos({
      agents: [agentA, agentB, agentC],
      profiles: [
        // agent-1: two proposed (oldest 2024-01-01) + one active (ignored)
        {
          id: 'p1',
          tenant_id: 'tenant-A',
          agent_id: 'agent-1',
          version: 2,
          status: 'proposed',
          profile_body: {},
          proposed_by: 'u1',
          proposed_reason: 'r',
          created_at: new Date('2024-01-02T00:00:00Z'),
        },
        {
          id: 'p2',
          tenant_id: 'tenant-A',
          agent_id: 'agent-1',
          version: 3,
          status: 'proposed',
          profile_body: {},
          proposed_by: 'u1',
          proposed_reason: 'r',
          created_at: new Date('2024-01-01T00:00:00Z'),
        },
        {
          id: 'p3',
          tenant_id: 'tenant-A',
          agent_id: 'agent-1',
          version: 1,
          status: 'active',
          profile_body: {},
          proposed_by: 'u1',
          proposed_reason: 'r',
          created_at: new Date('2023-12-01T00:00:00Z'),
        },
        // agent-2: one proposed, newer than agent-1's oldest
        {
          id: 'p4',
          tenant_id: 'tenant-A',
          agent_id: 'agent-2',
          version: 1,
          status: 'proposed',
          profile_body: {},
          proposed_by: 'u1',
          proposed_reason: 'r',
          created_at: new Date('2024-03-01T00:00:00Z'),
        },
        // agent-3: nothing proposed
      ],
    });

    const res = await caller('owner', 'tenant-A', 'u1', repos).pendingProfileApprovals({});

    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.agent_id)).toEqual(['agent-1', 'agent-2']);
    expect(res.items[0]).toMatchObject({
      agent_id: 'agent-1',
      agent_nome: 'Agente Um',
      pending_count: 2,
    });
    expect(res.items[0]!.oldest_created_at).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(res.items[1]).toMatchObject({ agent_id: 'agent-2', pending_count: 1 });
  });

  it('returns empty when no agent has proposed versions', async () => {
    const repos = makeRepos({ agents: [agentA] });
    const res = await caller('owner', 'tenant-A', 'u1', repos).pendingProfileApprovals({});
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });
});
