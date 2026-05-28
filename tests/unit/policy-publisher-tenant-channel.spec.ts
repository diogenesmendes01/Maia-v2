/**
 * Issue #249 — publisher-side proof: the policy repo publishes lifecycle
 * events on the per-tenant channel built from ALS context, and refuses
 * to publish without context.
 *
 * Strategy: mock both `@/lib/redis.js` (to capture publish calls) and
 * `@/db/client.js` (to stub the drizzle pipeline so activate/deprecate/
 * rollback can complete without Postgres). The mocked `db.update(...).set(...).where(...).returning()`
 * chain returns a row we control; the repo's internal helper
 * `publishLifecycle` then runs against the real `getCurrentTenant()`
 * and the mocked redis — exactly the path #249 fixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { PolicyRule } from '@/control-plane/policy/types.js';

// ---------- Mocks ----------
const publishCalls: Array<{ channel: string; payload: string }> = [];

vi.mock('@/lib/redis.js', () => ({
  redis: {
    publish: vi.fn(async (channel: string, payload: string) => {
      publishCalls.push({ channel, payload });
      return 1;
    }),
  },
}));

// Stub a drizzle chain: db.select().from().where().limit() and
// db.update().set().where().returning(). Each chain returns `this` until
// the terminal step yields the seeded row(s).
const dbRows: PolicyRule[] = [];

function seedRow(row: PolicyRule): void {
  dbRows.length = 0;
  dbRows.push(row);
}

const chain: Record<string, (...args: unknown[]) => unknown> = {};
chain.select = () => chain;
chain.from = () => chain;
chain.where = () => chain;
chain.limit = async () => dbRows.slice(0, 1);
chain.set = () => chain;
chain.update = () => chain;
chain.insert = () => chain;
chain.values = () => chain;
chain.returning = async () => dbRows.slice();
chain.orderBy = async () => dbRows.slice();

vi.mock('@/db/client.js', () => ({
  db: chain,
  pool: {},
}));

vi.mock('@/db/tenant-guard.js', () => ({
  applyTenantGuard: vi.fn(),
}));

// Re-import the repo AFTER mocks are wired so it picks up the stubs.
const { policyRulesRepo } = await import(
  '@/control-plane/policy/policy-rules-repo.js'
);

function makeRow(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'pol-1',
    tenant_id: 'tenant-a',
    agent_id: null,
    rule_kind: 'soft_guidance',
    rule_descriptor: 'd',
    rule_body: {},
    scope: {},
    source_of_truth: 'tenant_culture',
    status: 'proposed',
    version: 1,
    proposed_by: 'op',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    deprecated_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  publishCalls.length = 0;
  dbRows.length = 0;
});

describe('issue #249 — repo publishes on per-tenant channel via activate', () => {
  it('activate() in tenant-A context publishes on `policy_rule_lifecycle:tenant-a`', async () => {
    // Seed a proposed row that the activate will read.
    seedRow(makeRow({ tenant_id: 'tenant-a', status: 'proposed' }));
    // After update, returning() yields the updated row.
    dbRows.push(
      makeRow({
        tenant_id: 'tenant-a',
        status: 'active',
        approved_by: 'admin',
        approved_at: new Date(),
        activated_at: new Date(),
      }),
    );

    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const res = await policyRulesRepo.activate({
          id: 'pol-1',
          approved_by: 'admin',
        });
        expect(res.ok).toBe(true);
      },
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.channel).toBe('policy_rule_lifecycle:tenant-a');
    const payload = JSON.parse(publishCalls[0]?.payload ?? '{}');
    expect(payload.tenant_id).toBe('tenant-a');
    expect(payload.event).toBe('policy_rule_activated');
  });

  it('activate() in tenant-B context publishes on `policy_rule_lifecycle:tenant-b` — never on tenant-A channel', async () => {
    seedRow(makeRow({ tenant_id: 'tenant-b', status: 'proposed' }));
    dbRows.push(
      makeRow({
        tenant_id: 'tenant-b',
        status: 'active',
        approved_by: 'admin',
        approved_at: new Date(),
        activated_at: new Date(),
      }),
    );

    await runWithTenantContext(
      { tenant_id: 'tenant-b', agent_id: 'default' },
      async () => {
        const res = await policyRulesRepo.activate({
          id: 'pol-1',
          approved_by: 'admin',
        });
        expect(res.ok).toBe(true);
      },
    );

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.channel).toBe('policy_rule_lifecycle:tenant-b');
    // Crucially: tenant-A's channel was NEVER touched.
    expect(
      publishCalls.find((c) => c.channel === 'policy_rule_lifecycle:tenant-a'),
    ).toBeUndefined();
  });

  it('deprecate() publishes the per-tenant channel with `policy_rule_deprecated`', async () => {
    seedRow(makeRow({ tenant_id: 'tenant-a', status: 'active' }));
    dbRows.push(
      makeRow({
        tenant_id: 'tenant-a',
        status: 'deprecated',
        deprecated_at: new Date(),
      }),
    );

    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const res = await policyRulesRepo.deprecate({
          id: 'pol-1',
          deprecated_by: 'admin',
        });
        expect(res.ok).toBe(true);
      },
    );

    expect(publishCalls[0]?.channel).toBe('policy_rule_lifecycle:tenant-a');
    const payload = JSON.parse(publishCalls[0]?.payload ?? '{}');
    expect(payload.event).toBe('policy_rule_deprecated');
  });

  it('rollback() publishes the per-tenant channel with `policy_rule_rolled_back`', async () => {
    seedRow(makeRow({ tenant_id: 'tenant-a', status: 'active' }));
    dbRows.push(
      makeRow({
        tenant_id: 'tenant-a',
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: 'incident',
      }),
    );

    await runWithTenantContext(
      { tenant_id: 'tenant-a', agent_id: 'default' },
      async () => {
        const res = await policyRulesRepo.rollback({
          id: 'pol-1',
          rolled_back_by: 'admin',
          rollback_reason: 'incident',
        });
        expect(res.ok).toBe(true);
      },
    );

    expect(publishCalls[0]?.channel).toBe('policy_rule_lifecycle:tenant-a');
    const payload = JSON.parse(publishCalls[0]?.payload ?? '{}');
    expect(payload.event).toBe('policy_rule_rolled_back');
  });

  it('activate() without ANY tenant context throws `MISSING_TENANT_CONTEXT` (no publish happens)', async () => {
    // Note: getCurrentTenant() at the *start* of activate() already
    // throws when called outside runWithTenantContext. We assert that
    // (a) the call throws, (b) redis.publish was never reached.
    await expect(
      policyRulesRepo.activate({ id: 'pol-1', approved_by: 'admin' }),
    ).rejects.toThrow(/Tenant context/i);
    expect(publishCalls).toHaveLength(0);
  });
});
