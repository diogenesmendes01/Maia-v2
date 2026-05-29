/**
 * P8e Task 10 — Integration test for the end-to-end P8e flow.
 *
 * Spec §8.2. Covers 5 scenarios using mocks (no Postgres in CI for this PR):
 *   1. Seed creates 5 active policies for tenant=default.
 *   2. Resolver returns 5 resolved / 0 unresolved for the seed descriptors.
 *   3. Tenant isolation: A cannot resolve B's descriptors, vice-versa.
 *   4. deprecate() + cache invalidation → resolver returns unresolved.
 *   5. propose() + activate() new version → resolver returns new version.
 *
 * Pattern matches tests/integration/p4-operational-identity.spec.ts:
 * mock the repo with an in-memory state, build a fresh resolver+cache for
 * each scenario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  PolicyResolverCacheImpl,
  createPolicyDescriptorResolver,
  handlePolicyLifecycleMessage,
  isValidDualApprovalEvidence,
  POLICY_LIFECYCLE_CHANNEL,
  buildPolicyLifecycleChannel,
  type PolicyRule,
  type PolicyRuleBody,
  type PolicyRuleKind,
  type PolicyRuleScope,
  type PolicyRulesRepo,
  type PolicySourceOfTruth,
  type PolicyLifecycleEvent,
} from '@/control-plane/policy/index.js';

type ProposeInput = {
  agent_id?: string | null;
  rule_kind: PolicyRuleKind;
  rule_descriptor: string;
  rule_body: PolicyRuleBody;
  scope?: PolicyRuleScope;
  source_of_truth: PolicySourceOfTruth;
  proposed_by: string;
  proposed_reason?: string;
};

const SEED_DESCRIPTORS = [
  'no_refund_without_validation',
  'lgpd_strict_no_pii_in_logs',
  'no_action_outside_business_hours_high_risk',
  'tenant_lockdown_blocks_all_writes',
  'no_financial_advice_without_compliance_disclaimer',
] as const;

const SEED_DEFS: ProposeInput[] = [
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_refund_without_validation',
    rule_body: { predicate: {}, effect: {} },
    source_of_truth: 'founder_explicit',
    proposed_by: 'p8e_seed',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'lgpd_strict_no_pii_in_logs',
    rule_body: { predicate: {}, effect: {} },
    source_of_truth: 'legal_compliance',
    proposed_by: 'p8e_seed',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_action_outside_business_hours_high_risk',
    rule_body: { predicate: {}, effect: {} },
    scope: { channel: 'whatsapp' },
    source_of_truth: 'founder_explicit',
    proposed_by: 'p8e_seed',
  },
  {
    rule_kind: 'lockdown_trigger',
    rule_descriptor: 'tenant_lockdown_blocks_all_writes',
    rule_body: { predicate: {}, effect: {} },
    source_of_truth: 'founder_explicit',
    proposed_by: 'p8e_seed',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_financial_advice_without_compliance_disclaimer',
    rule_body: { predicate: {}, effect: {} },
    source_of_truth: 'legal_compliance',
    proposed_by: 'p8e_seed',
  },
];

// ----- In-memory repo -----
const state: Record<string, PolicyRule> = {};

function findActive(
  tenant_id: string,
  agent_id: string | null,
  descriptor: string,
): PolicyRule | null {
  return (
    Object.values(state).find(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.rule_descriptor === descriptor &&
        r.status === 'active',
    ) ?? null
  );
}

function makeFakeRepo(
  invalidate: (args: {
    tenant_id: string;
    agent_id: string | null;
    descriptor: string;
  }) => void,
): PolicyRulesRepo {
  const repo: PolicyRulesRepo = {
    async findActiveByDescriptor(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      if (args.agent_id) {
        const a = findActive(tenant_id, args.agent_id, args.descriptor);
        if (a) return a;
      }
      return findActive(tenant_id, null, args.descriptor);
    },
    async findActiveCandidates(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const candidates: PolicyRule[] = [];
      // Agent-specific row first, then tenant-wide (agent_id IS NULL).
      if (args.agent_id) {
        const agentRow = findActive(tenant_id, args.agent_id, args.descriptor);
        if (agentRow) candidates.push(agentRow);
      }
      const tenantRow = findActive(tenant_id, null, args.descriptor);
      if (tenantRow) candidates.push(tenantRow);
      return candidates;
    },
    async listActiveForTenant() {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      return Object.values(state).filter(
        (r) => r.tenant_id === tenant_id && r.status === 'active',
      );
    },
    async listVersions(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const agent_id = args.agent_id ?? null;
      return Object.values(state)
        .filter(
          (r) =>
            r.tenant_id === tenant_id &&
            r.agent_id === agent_id &&
            r.rule_descriptor === args.descriptor,
        )
        .sort((a, b) => b.version - a.version);
    },
    async getById(id) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const r = state[id];
      if (!r || r.tenant_id !== tenant_id) return null;
      return r;
    },
    async nextVersion(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const agent_id = args.agent_id ?? null;
      const rows = Object.values(state).filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.rule_descriptor === args.descriptor,
      );
      if (rows.length === 0) return 1;
      return Math.max(...rows.map((r) => r.version)) + 1;
    },
    async propose(input: ProposeInput) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const agent_id = input.agent_id ?? null;
      const version = await repo.nextVersion({
        descriptor: input.rule_descriptor,
        agent_id,
      });
      const id = `pol-${Math.random().toString(36).slice(2)}`;
      const row: PolicyRule = {
        id,
        tenant_id,
        agent_id,
        rule_kind: input.rule_kind,
        rule_descriptor: input.rule_descriptor,
        rule_body: input.rule_body,
        scope: input.scope ?? {},
        source_of_truth: input.source_of_truth,
        status: 'proposed',
        version,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
        approved_by: null,
        approved_at: null,
        activated_at: null,
        deprecated_at: null,
        rolled_back_at: null,
        rollback_reason: null,
        created_at: new Date(),
      };
      state[id] = row;
      return row;
    },
    async activate(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'proposed') {
        return { ok: false, reason: 'invalid_transition' };
      }
      const requiresDual =
        row.rule_kind === 'hard_limit' || row.rule_kind === 'lockdown_trigger';
      if (requiresDual) {
        if (!args.dual_approval_evidence) {
          return { ok: false, reason: 'hard_limit_requires_dual_approval' };
        }
        if (!isValidDualApprovalEvidence(args.dual_approval_evidence)) {
          return { ok: false, reason: 'invalid_dual_approval_evidence' };
        }
        if (args.dual_approval_evidence.approvers.includes(args.approved_by)) {
          return { ok: false, reason: 'invalid_dual_approval_evidence' };
        }
      }
      const existing = findActive(row.tenant_id, row.agent_id, row.rule_descriptor);
      if (existing) {
        return { ok: false, reason: 'already_has_active' };
      }
      const now = new Date();
      const updated: PolicyRule = {
        ...row,
        status: 'active',
        approved_by: args.approved_by,
        approved_at: now,
        activated_at: now,
      };
      state[row.id] = updated;
      invalidate({
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        descriptor: row.rule_descriptor,
      });
      return { ok: true, updated };
    },
    async deprecate(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'active') {
        return { ok: false, reason: 'invalid_transition' };
      }
      const updated: PolicyRule = {
        ...row,
        status: 'deprecated',
        deprecated_at: new Date(),
      };
      state[row.id] = updated;
      invalidate({
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        descriptor: row.rule_descriptor,
      });
      return { ok: true, updated };
    },
    async rollback(args) {
      const tenant_id = (await import('@/db/tenant-context.js')).getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status === 'rolled_back') {
        return { ok: false, reason: 'terminal' };
      }
      const updated: PolicyRule = {
        ...row,
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: args.rollback_reason,
      };
      state[row.id] = updated;
      invalidate({
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        descriptor: row.rule_descriptor,
      });
      return { ok: true, updated };
    },
  };
  return repo;
}

/**
 * Seeds 5 policies as active for the current tenant. Mirrors the SQL
 * migration 037 logic: NOT EXISTS guard via findActiveByDescriptor.
 * Uses the new structured DualApprovalEvidence (Codex #93).
 */
async function seedFiveDefaults(repo: PolicyRulesRepo): Promise<number> {
  const now = new Date().toISOString();
  let created = 0;
  for (const def of SEED_DEFS) {
    const existing = await repo.findActiveByDescriptor({
      descriptor: def.rule_descriptor,
      agent_id: null,
    });
    if (existing) continue;
    const proposed = await repo.propose(def);
    const res = await repo.activate({
      id: proposed.id,
      approved_by: 'p8e_seed_executor',
      dual_approval_evidence: {
        approvers: ['seed_owner', 'seed_compliance'],
        approved_at: [now, now],
      },
    });
    if (res.ok) created++;
  }
  return created;
}

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
});

describe('p8e policy resolver — integration', () => {
  it('seed creates 5 active policies for tenant=default', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const created = await seedFiveDefaults(repo);
        expect(created).toBe(5);
        const active = await repo.listActiveForTenant();
        expect(active).toHaveLength(5);
        // Idempotency: second run should not duplicate.
        const again = await seedFiveDefaults(repo);
        expect(again).toBe(0);
        const stillFive = await repo.listActiveForTenant();
        expect(stillFive).toHaveLength(5);
      },
    );
  });

  it('resolver returns 5 resolved, 0 unresolved for the seed descriptors', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    const resolver = createPolicyDescriptorResolver(repo, cache);
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        await seedFiveDefaults(repo);
        // Note: no_action_outside_business_hours_high_risk has scope=whatsapp,
        // so we pass scope.channel=whatsapp to match it. Other 4 are scope-less.
        const out = await resolver.resolveDescriptors({
          tenant_id: 'default',
          descriptors: [...SEED_DESCRIPTORS],
          scope: { channel: 'whatsapp' },
        });
        expect(out.resolved).toHaveLength(5);
        expect(out.unresolved).toHaveLength(0);
      },
    );
  });

  it('tenant isolation: tenant B cannot resolve tenant A descriptors', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    const resolver = createPolicyDescriptorResolver(repo, cache);

    // Tenant A: create a custom descriptor.
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const p = await repo.propose({
          rule_kind: 'soft_guidance',
          rule_descriptor: 'a_only',
          rule_body: {},
          source_of_truth: 'tenant_culture',
          proposed_by: 'op',
        });
        const r = await repo.activate({ id: p.id, approved_by: 'op' });
        expect(r.ok).toBe(true);
      },
    );
    // Tenant B: same descriptor should NOT resolve.
    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'default' },
      async () => {
        const out = await resolver.resolveDescriptors({
          tenant_id: 'tenant-b',
          descriptors: ['a_only'],
        });
        expect(out.resolved).toHaveLength(0);
        expect(out.unresolved).toEqual(['a_only']);
      },
    );
    // Tenant A still resolves its own.
    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const out = await resolver.resolveDescriptors({
          tenant_id: 'tenant-a',
          descriptors: ['a_only'],
        });
        expect(out.resolved).toHaveLength(1);
      },
    );
  });

  it('deprecate + cache invalidation → resolver returns unresolved', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    const resolver = createPolicyDescriptorResolver(repo, cache);
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const p = await repo.propose({
          rule_kind: 'soft_guidance',
          rule_descriptor: 'to_deprecate',
          rule_body: {},
          source_of_truth: 'tenant_culture',
          proposed_by: 'op',
        });
        const act = await repo.activate({ id: p.id, approved_by: 'op' });
        expect(act.ok).toBe(true);

        // First resolution caches it.
        const before = await resolver.resolveDescriptors({
          tenant_id: 'default',
          descriptors: ['to_deprecate'],
        });
        expect(before.resolved).toHaveLength(1);

        // Deprecate fires the invalidate callback.
        const dep = await repo.deprecate({
          id: p.id,
          deprecated_by: 'op',
        });
        expect(dep.ok).toBe(true);

        // Resolver should NOT return the deprecated row.
        const after = await resolver.resolveDescriptors({
          tenant_id: 'default',
          descriptors: ['to_deprecate'],
        });
        expect(after.resolved).toHaveLength(0);
        expect(after.unresolved).toEqual(['to_deprecate']);
      },
    );
  });

  it('propose + activate new version → resolver returns the new version', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    const resolver = createPolicyDescriptorResolver(repo, cache);
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // v1 active.
        const p1 = await repo.propose({
          rule_kind: 'soft_guidance',
          rule_descriptor: 'versioned',
          rule_body: {},
          source_of_truth: 'tenant_culture',
          proposed_by: 'op',
        });
        await repo.activate({ id: p1.id, approved_by: 'op' });
        const v1 = await resolver.resolveDescriptors({
          tenant_id: 'default',
          descriptors: ['versioned'],
        });
        expect(v1.resolved[0]?.version).toBe(1);

        // Deprecate v1, propose+activate v2.
        await repo.deprecate({ id: p1.id, deprecated_by: 'op' });
        const p2 = await repo.propose({
          rule_kind: 'soft_guidance',
          rule_descriptor: 'versioned',
          rule_body: { changed: true },
          source_of_truth: 'tenant_culture',
          proposed_by: 'op',
        });
        const a2 = await repo.activate({ id: p2.id, approved_by: 'op' });
        expect(a2.ok).toBe(true);
        if (!a2.ok) return;
        expect(a2.updated.version).toBe(2);

        const v2 = await resolver.resolveDescriptors({
          tenant_id: 'default',
          descriptors: ['versioned'],
        });
        expect(v2.resolved).toHaveLength(1);
        expect(v2.resolved[0]?.version).toBe(2);
        expect(v2.resolved[0]?.policy_id).toBe(p2.id);
      },
    );
  });

  it('cache hit rate is high for repeated identical lookups (gate 5)', async () => {
    const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
    const repo = makeFakeRepo((k) => cache.invalidate(k));
    const resolver = createPolicyDescriptorResolver(repo, cache);
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        await seedFiveDefaults(repo);
        // 100 identical lookups
        for (let i = 0; i < 100; i++) {
          await resolver.resolveDescriptors({
            tenant_id: 'default',
            descriptors: ['no_refund_without_validation'],
          });
        }
        const stats = cache.stats();
        const total = stats.hits + stats.misses;
        // First is miss; rest are hits → ≥99% hit rate.
        expect(stats.hits / total).toBeGreaterThanOrEqual(0.8);
      },
    );
  });

  // ----- Codex review #93: lifecycle pub/sub → cache invalidation wiring -----
  describe('cache invalidation pub/sub wiring (Codex #93)', () => {
    it('handlePolicyLifecycleMessage invalidates the cache for every lifecycle event kind', () => {
      // This is the "pure handler" used by the Redis subscriber. We
      // simulate Redis delivering each lifecycle event kind and verify
      // every one drops the matching cache entry. Catches regressions
      // where one new event kind ships without being wired up.
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      const make = (descriptor: string) => ({
        descriptor,
        policy_id: `pol-${descriptor}`,
        version: 1,
        rule_kind: 'soft_guidance' as const,
      });

      const eventKinds: PolicyLifecycleEvent['event'][] = [
        'policy_rule_activated',
        'policy_rule_deprecated',
        'policy_rule_rolled_back',
      ];
      for (const eventKind of eventKinds) {
        const desc = `lifecycle_${eventKind}`;
        cache.set(
          {
            tenant_id: 'default',
            agent_id: 'agent-x',
            descriptor: desc,
            scope: {},
          },
          make(desc),
        );
        expect(
          cache.get({
            tenant_id: 'default',
            agent_id: 'agent-x',
            descriptor: desc,
            scope: {},
          }),
        ).toBeDefined();

        const evt: PolicyLifecycleEvent = {
          event: eventKind,
          tenant_id: 'default',
          agent_id: 'agent-x',
          descriptor: desc,
        };
        // Issue #249: per-tenant channel name.
        handlePolicyLifecycleMessage(
          buildPolicyLifecycleChannel('default'),
          JSON.stringify(evt),
          cache,
        );
        expect(
          cache.get({
            tenant_id: 'default',
            agent_id: 'agent-x',
            descriptor: desc,
            scope: {},
          }),
        ).toBeUndefined();
      }
    });

    it('handlePolicyLifecycleMessage with agent_id=null invalidates ALL agent-cached entries for the (tenant, descriptor)', () => {
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      const make = (d: string) => ({
        descriptor: d,
        policy_id: `pol-${d}`,
        version: 1,
        rule_kind: 'soft_guidance' as const,
      });
      for (const a of [null, 'agent-x', 'agent-y']) {
        cache.set(
          {
            tenant_id: 'default',
            agent_id: a,
            descriptor: 'wide_event',
            scope: {},
          },
          make('wide_event'),
        );
      }
      const evt: PolicyLifecycleEvent = {
        event: 'policy_rule_deprecated',
        tenant_id: 'default',
        agent_id: null,
        descriptor: 'wide_event',
      };
      // Issue #249: per-tenant channel name.
      handlePolicyLifecycleMessage(
        buildPolicyLifecycleChannel('default'),
        JSON.stringify(evt),
        cache,
      );
      // All 3 must be gone.
      for (const a of [null, 'agent-x', 'agent-y']) {
        expect(
          cache.get({
            tenant_id: 'default',
            agent_id: a,
            descriptor: 'wide_event',
            scope: {},
          }),
        ).toBeUndefined();
      }
    });

    it('handlePolicyLifecycleMessage ignores messages on other channels', () => {
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      cache.set(
        { tenant_id: 't', agent_id: null, descriptor: 'd', scope: {} },
        {
          descriptor: 'd',
          policy_id: 'p',
          version: 1,
          rule_kind: 'soft_guidance',
        },
      );
      handlePolicyLifecycleMessage(
        'unrelated_channel',
        JSON.stringify({
          event: 'policy_rule_activated',
          tenant_id: 't',
          agent_id: null,
          descriptor: 'd',
        }),
        cache,
      );
      // Untouched.
      expect(
        cache.get({ tenant_id: 't', agent_id: null, descriptor: 'd', scope: {} }),
      ).toBeDefined();
    });

    it('handlePolicyLifecycleMessage drops events on the LEGACY bare channel (issue #249)', () => {
      // After the per-tenant channel rollout, the pre-#249 bare channel
      // name `policy_rule_lifecycle` is no longer a valid delivery target.
      // A stale publisher emitting on it MUST NOT invalidate cache —
      // accepting it would re-open the global-routing hole.
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      cache.set(
        { tenant_id: 't', agent_id: null, descriptor: 'd', scope: {} },
        {
          descriptor: 'd',
          policy_id: 'p',
          version: 1,
          rule_kind: 'soft_guidance',
        },
      );
      handlePolicyLifecycleMessage(
        POLICY_LIFECYCLE_CHANNEL, // legacy bare name (no `:tenant` suffix)
        JSON.stringify({
          event: 'policy_rule_deprecated',
          tenant_id: 't',
          agent_id: null,
          descriptor: 'd',
        }),
        cache,
      );
      // Entry survives — the bare channel is dropped (TTL fallback only).
      expect(
        cache.get({ tenant_id: 't', agent_id: null, descriptor: 'd', scope: {} }),
      ).toBeDefined();
    });

    it('handlePolicyLifecycleMessage swallows malformed JSON without throwing', () => {
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      expect(() => {
        handlePolicyLifecycleMessage(
          buildPolicyLifecycleChannel('default'),
          'not-json',
          cache,
        );
      }).not.toThrow();
    });

    it('end-to-end: repo.deprecate publishes → handler invalidates → resolver returns unresolved (with fail-closed contract)', async () => {
      // Wires the repo's invalidate callback to handlePolicyLifecycleMessage
      // via the synthesized JSON event payload — proving the Redis-side
      // path is equivalent to the in-process callback.
      const cache = new PolicyResolverCacheImpl({ ttl_ms: 60_000, max_entries: 100 });
      const repo = makeFakeRepo((k) => {
        const evt: PolicyLifecycleEvent = {
          event: 'policy_rule_deprecated',
          ...k,
        };
        // Issue #249: per-tenant channel routing.
        handlePolicyLifecycleMessage(
          buildPolicyLifecycleChannel(k.tenant_id),
          JSON.stringify(evt),
          cache,
        );
      });
      const resolver = createPolicyDescriptorResolver(repo, cache);
      await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'default' },
        async () => {
          const p = await repo.propose({
            rule_kind: 'soft_guidance',
            rule_descriptor: 'pubsub_e2e',
            rule_body: {},
            source_of_truth: 'tenant_culture',
            proposed_by: 'op',
          });
          await repo.activate({ id: p.id, approved_by: 'op' });

          const before = await resolver.resolveDescriptors({
            tenant_id: 'default',
            descriptors: ['pubsub_e2e'],
          });
          expect(before.resolved).toHaveLength(1);

          await repo.deprecate({ id: p.id, deprecated_by: 'op' });

          const after = await resolver.resolveDescriptors({
            tenant_id: 'default',
            descriptors: ['pubsub_e2e'],
          });
          expect(after.resolved).toHaveLength(0);
          expect(after.failures).toEqual([
            { descriptor: 'pubsub_e2e', reason: 'not_found' },
          ]);
        },
      );
    });
  });
});
