/**
 * Issue #370 — MUTATION ISOLATION for `capabilityGapsRepo.upsert`.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * `capabilityGapsRepo.upsert` is a MANUAL read-then-write (NOT a Postgres
 * `onConflictDoUpdate`): it runs a correctly tenant-scoped SELECT by
 * `capability_description`, and — when a row already exists — issues an UPDATE
 * that bumps `frequency_score`/`last_observed`. The regression (#370, same class
 * as #367/#368, "id is not an isolation boundary") was that the UPDATE arm
 * filtered by `id` ALONE: `where(eq(agent_capability_gaps.id, existing[0].id))`,
 * with no `tenant_id`/`agent_id` predicate. So an `id` that collides across
 * tenants (a stale/leaked id) let tenant-A's upsert bump tenant-B's row.
 *
 * The fix mirrors the sibling `capabilityGapsRepo.updateLevel`, adding
 * `and(eq(id, …), eq(tenant_id, …), eq(agent_id, …))` to the UPDATE `.where()`.
 *
 * This spec drives the REAL repo method against the in-memory, tenant-keyed
 * store (`makeTenantScopedUpdateStore`) whose UPDATE/SELECT is applied by
 * EVALUATING the method's ACTUAL drizzle WHERE clause — so a missing
 * tenant/agent binding is observable as a foreign tenant's row being mutated
 * (the exact regression lever). It seeds tenant-A + tenant-B (+ cross-agent)
 * rows that SHARE the targeted `id` AND `capability_description`, runs `upsert`
 * under tenant-A's context, and asserts:
 *   (1) ONLY tenant-A's row was bumped (tenant-B + other-agent untouched), and
 *   (2) the executed UPDATE WHERE actually bound BOTH `tenant_id` AND `agent_id`
 *       (revert-check: dropping either binding fails here even if the row-state
 *       assertion happened to pass for a given seed).
 *
 * Pre-fix revert-check: against the old id-only predicate the shared-id rows ALL
 * match, so assertion (1) fails (tenant-B's `frequency_score` is bumped) and
 * assertion (2) fails (no tenant/agent term present in the UPDATE WHERE).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
  type TenantScopedUpdateStore,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };
const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };

// In-memory, tenant-keyed store standing in for `@/db/client.js`. The REAL repo
// method runs its drizzle SELECT / UPDATE against this.
const store: TenantScopedUpdateStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: store.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

beforeEach(() => {
  store.reset([]);
});

/** Assert the UPDATE WHERE bound BOTH tenant + agent for tenant-A. */
function expectBoundTenantAgent(predicate: unknown): void {
  const terms = parsePredicateForTest(predicate);
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
}

describe("#370 — capabilityGapsRepo.upsert() bumps ONLY the current tenant/agent's gap", () => {
  const DESC = 'send_invoice_pdf';
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'gap',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a', // not a real column; present only so StoreRow typechecks
    capability_description: DESC,
    tipo: 'tool',
    frequency_score: 1,
    last_observed: new Date('2020-01-01T00:00:00.000Z'),
    ...over,
  });

  it('leaves tenant-B (and other-agent) gaps UNTOUCHED on a colliding id', async () => {
    // All three rows SHARE the `id` AND the `capability_description`. The
    // tenant-scoped SELECT resolves tenant-A's row; the OLD id-only UPDATE would
    // then ALSO match tenant-B's + other-agent's rows for the same id.
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A', frequency_score: 5 }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B', frequency_score: 100 }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z', frequency_score: 200 }),
    ]);
    const { capabilityGapsRepo } = await import('@/db/repositories.js');

    const returned = await runWithTenantContext(A, () =>
      capabilityGapsRepo.upsert({ capability_description: DESC, tipo: 'tool' }),
    );

    const byId = store.rows.filter((r) => r.id === 'shared');
    // tenant-A/agent-A: bumped 5 -> 6 and last_observed advanced.
    const a = byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!;
    expect(a.frequency_score).toBe(6);
    expect((a.last_observed as Date).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );
    // cross-tenant + cross-agent rows are byte-for-byte untouched.
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.frequency_score).toBe(100);
    expect(byId.find((r) => r.agent_id === 'agent-Z')!.frequency_score).toBe(200);
    // The method returns the matched (current-tenant) row.
    expect(returned.tenant_id).toBe('tenant-A');
    expect(returned.agent_id).toBe('agent-A');
    // Revert-check: the executed UPDATE WHERE bound BOTH tenant_id AND agent_id.
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('INSERTs a fresh tenant-stamped row when none exists for the description', async () => {
    store.reset([]);
    const { capabilityGapsRepo } = await import('@/db/repositories.js');

    const created = await runWithTenantContext(A, () =>
      capabilityGapsRepo.upsert({ capability_description: 'brand_new', tipo: 'knowledge' }),
    );

    expect(created.tenant_id).toBe('tenant-A');
    expect(created.agent_id).toBe('agent-A');
    expect(created.capability_description).toBe('brand_new');
    const stored = store.rows.find((r) => r.capability_description === 'brand_new')!;
    expect(stored.tenant_id).toBe('tenant-A');
    expect(stored.agent_id).toBe('agent-A');
  });

  it("does NOT bump a tenant-B row whose id collides when tenant-A has NO matching gap", async () => {
    // tenant-B owns the only row for this id+description. tenant-A's SELECT finds
    // nothing of its own, so it falls through to INSERT a NEW row — it must never
    // reach into tenant-B's row via the (old) id-only UPDATE arm.
    store.reset([
      row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B', frequency_score: 42 }),
    ]);
    const { capabilityGapsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      capabilityGapsRepo.upsert({ capability_description: DESC, tipo: 'tool' }),
    );

    // tenant-B's row is never bumped.
    expect(store.rows.find((r) => r.tenant_id === 'tenant-B')!.frequency_score).toBe(42);
    // A fresh tenant-A row was inserted instead.
    const a = store.rows.find((r) => r.tenant_id === 'tenant-A' && r.capability_description === DESC);
    expect(a).toBeDefined();
  });
});
