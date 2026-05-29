/**
 * P9b (Camada 3 #3/4) — ChannelPoliciesReaderAdapter unit tests.
 *
 * Verifies that the production adapter in prod-env.ts reads agent_id directly
 * from channel_policies (no JOIN required), enforces tenant isolation via the
 * WHERE predicate, and falls back to getCurrentAgent() when no row exists.
 *
 * Mocking strategy: mock @/db/client.js to expose a controllable in-memory
 * store, and mock @/db/tenant-context.js for the fallback path. No live DB.
 *
 * Test IDs:
 *  T1: channel_policies row exists → returns stored agent_id
 *  T2: no channel_policies row → falls back to getCurrentAgent()
 *  T3: row exists but for a different channel → no match → fallback
 *  T4: cross-tenant isolation — channel_id exists in T1, query with T2 → fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory store shared by the mocked drizzle db
// ---------------------------------------------------------------------------
type PolicyRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  channel_id: string;
  default_role_id: string;
};

const store: PolicyRow[] = [];

// ---------------------------------------------------------------------------
// Mock: @/db/client.js — provides a controllable drizzle-shaped db singleton
// ---------------------------------------------------------------------------
vi.mock('@/db/client.js', () => {
  // Minimal drizzle-ORM query builder shim. The adapter calls:
  //   db.select({ agent_id: channel_policies.agent_id })
  //     .from(channel_policies)
  //     .where(and(eq(...), eq(...)))
  //     .limit(1)
  // We capture the WHERE args and simulate the filter against `store`.
  return {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn((_n: number) => {
        // At this point, the WHERE clause has been called with a drizzle
        // SQL object. We intercept via the `_lastWhere` closure captured
        // in `where()`. For simplicity, the actual filtering logic is
        // injected via the `_filterFn` hook below.
        return Promise.resolve([]);
      }),
      // We'll re-implement these per test via vi.mocked().
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: @/db/schema.js — just need the channel_policies table reference
// ---------------------------------------------------------------------------
vi.mock('@/db/schema.js', () => ({
  channel_policies: {
    tenant_id: { name: 'tenant_id' },
    channel_id: { name: 'channel_id' },
    agent_id:   { name: 'agent_id' },
  },
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm — eq/and are passed through as identity so we can
// capture the WHERE args from outside
// ---------------------------------------------------------------------------
vi.mock('drizzle-orm', () => ({
  eq:  vi.fn((col: unknown, val: unknown) => ({ _op: 'eq',  col, val })),
  and: vi.fn((...args: unknown[]) => ({ _op: 'and', args })),
}));

// ---------------------------------------------------------------------------
// Mock: @/db/tenant-context.js — fallback agent
// ---------------------------------------------------------------------------
vi.mock('@/db/tenant-context.js', () => ({
  getCurrentAgent: vi.fn().mockReturnValue('fallback_agent'),
  getCurrentTenant: vi.fn().mockReturnValue('tenant_fallback'),
}));

// ---------------------------------------------------------------------------
// Helper: rewire the db mock so .limit(1) resolves to filtered rows
// ---------------------------------------------------------------------------
import { db } from '@/db/client.js';

function setupDbQuery(filter: (row: PolicyRow) => boolean): void {
  // Each drizzle call chain returns `this` until .limit() which resolves.
  // We rebuild the chain each time so previous chain captures don't leak.
  let tenantPred: { val: string } | null = null;
  let channelPred: { val: string } | null = null;

  vi.mocked(db).select = vi.fn().mockReturnThis() as unknown as typeof db['select'];
  vi.mocked(db).from   = vi.fn().mockReturnThis() as unknown as typeof db['from'];
  vi.mocked(db).where  = vi.fn().mockImplementation((clause: unknown) => {
    // Drill into the and({ args: [eq1, eq2] }) structure built by eq/and mocks.
    const andClause = clause as { _op: string; args: Array<{ col: { name: string }; val: string }> };
    if (andClause._op === 'and') {
      for (const arg of andClause.args) {
        if (arg.col?.name === 'tenant_id') tenantPred = arg;
        if (arg.col?.name === 'channel_id') channelPred = arg;
      }
    }
    return db;
  }) as unknown as typeof db['where'];
  vi.mocked(db).limit  = vi.fn().mockImplementation((_n: number) => {
    const matched = store.filter((row) => {
      const tenantOk  = tenantPred  ? row.tenant_id  === tenantPred.val  : true;
      const channelOk = channelPred ? row.channel_id === channelPred.val : true;
      return tenantOk && channelOk && filter(row);
    }).slice(0, 1);
    return Promise.resolve(matched.map((r) => ({ agent_id: r.agent_id })));
  }) as unknown as typeof db['limit'];
}

// ---------------------------------------------------------------------------
// Import the adapter factory AFTER all mocks are registered
// ---------------------------------------------------------------------------
import { createProductionDecisionEngineEnv } from '@/runtime/decision/prod-env.js';

describe('ChannelPoliciesReaderAdapter — Camada 3 #3/4', () => {
  beforeEach(() => {
    store.length = 0;
    vi.clearAllMocks();
    // Default: return no rows (override per test as needed)
    setupDbQuery(() => true);
  });

  // -------------------------------------------------------------------------
  // T1: row exists → returns stored agent_id
  // -------------------------------------------------------------------------
  it('T1: channel_policies row exists → returns stored agent_id', async () => {
    store.push({
      id: 'pol-1',
      tenant_id: 'tenant_A',
      agent_id: 'agent_A1',
      channel_id: '11111111-1111-1111-1111-111111111111',
      default_role_id: 'role-atendimento',
    });
    setupDbQuery(() => true);

    const env = createProductionDecisionEngineEnv();
    const policy = await env.channelPolicies.getForChannel(
      'tenant_A',
      '11111111-1111-1111-1111-111111111111',
    );

    expect(policy.default_agent_id).toBe('agent_A1');
    expect(policy.tenant_id).toBe('tenant_A');
    expect(policy.channel_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  // -------------------------------------------------------------------------
  // T2: no row → falls back to getCurrentAgent()
  // -------------------------------------------------------------------------
  it('T2: no channel_policies row → falls back to getCurrentAgent()', async () => {
    // store is empty, setupDbQuery returns nothing
    setupDbQuery(() => true);

    const env = createProductionDecisionEngineEnv();
    const policy = await env.channelPolicies.getForChannel(
      'tenant_B',
      '22222222-2222-2222-2222-222222222222',
    );

    // No row → fallback
    expect(policy.default_agent_id).toBe('fallback_agent');
    expect(policy.tenant_id).toBe('tenant_B');
    expect(policy.channel_id).toBe('22222222-2222-2222-2222-222222222222');
  });

  // -------------------------------------------------------------------------
  // T3: row exists for a different channel → no match → fallback
  // -------------------------------------------------------------------------
  it('T3: row for different channel → no match → falls back to getCurrentAgent()', async () => {
    store.push({
      id: 'pol-2',
      tenant_id: 'tenant_C',
      agent_id: 'agent_C9',
      channel_id: '33333333-3333-3333-3333-333333333333',
      default_role_id: 'role-suporte',
    });
    setupDbQuery(() => true);

    const env = createProductionDecisionEngineEnv();
    // Querying a different channel_id than what's in the store
    const policy = await env.channelPolicies.getForChannel(
      'tenant_C',
      '99999999-9999-9999-9999-999999999999',  // not in store
    );

    expect(policy.default_agent_id).toBe('fallback_agent');
  });

  // -------------------------------------------------------------------------
  // T4: cross-tenant isolation — channel_id exists under T1, query with T2
  // -------------------------------------------------------------------------
  it('T4: cross-tenant isolation — channel_id in T1 is invisible to T2', async () => {
    store.push({
      id: 'pol-3',
      tenant_id: 'tenant_T1',
      agent_id: 'agent_T1_secret',
      channel_id: '44444444-4444-4444-4444-444444444444',
      default_role_id: 'role-default',
    });
    setupDbQuery(() => true);

    const env = createProductionDecisionEngineEnv();
    // T2 queries same channel_id but different tenant
    const policy = await env.channelPolicies.getForChannel(
      'tenant_T2',           // different tenant!
      '44444444-4444-4444-4444-444444444444',   // same channel_id as T1
    );

    // Tenant isolation: must NOT return T1's agent
    expect(policy.default_agent_id).not.toBe('agent_T1_secret');
    // Falls back to context agent
    expect(policy.default_agent_id).toBe('fallback_agent');
  });

  // -------------------------------------------------------------------------
  // T5: the single-channel 'default' sentinel is NOT a uuid. channel_policies
  // .channel_id is a `uuid` column, so querying it with 'default' makes
  // Postgres throw `invalid input syntax for type uuid` and fail-closes the
  // whole Decision Engine turn. The adapter must short-circuit BEFORE the DB
  // call and fall back to getCurrentAgent(). Regression for the prod incident
  // where Maia replied "Sistema indisponível" / "Pode me dar mais detalhes".
  // -------------------------------------------------------------------------
  it("T5: 'default' channel sentinel → skips uuid query → fallback agent", async () => {
    setupDbQuery(() => true);

    const env = createProductionDecisionEngineEnv();
    const policy = await env.channelPolicies.getForChannel('default', 'default');

    expect(policy.default_agent_id).toBe('fallback_agent');
    expect(policy.channel_id).toBe('default');
    // The guard must run before any DB access — never query a uuid column
    // with a non-uuid value.
    expect(db.select).not.toHaveBeenCalled();
  });
});
