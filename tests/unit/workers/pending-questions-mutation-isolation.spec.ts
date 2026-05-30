/**
 * Issue #355 (H2 of #323) — MUTATION ISOLATION for the `pendingQuestionsRepo`
 * single-row / per-conversa mutations.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * H1 (#357) hardened the conversas/mensagens hot-path mutations; this H2 closes
 * the analogous gap in `pendingQuestionsRepo`: four mutations were scoped ONLY
 * by `id`/`conversa_id` with NO tenant predicate, so once multi-tenant a caller
 * (or a stale/foreign id) could write across the tenant boundary. After the fix
 * each carries a `tenant_id = <ALS> AND agent_id = <ALS>` predicate (mirroring
 * the already-hardened `expireDue` / `conversasRepo.close`).
 *
 * This spec drives the REAL repo methods against an in-memory store keyed by
 * tenant (`makeTenantScopedUpdateStore`) whose UPDATE is applied by EVALUATING
 * the method's actual WHERE clause — the drizzle builder predicate for `resolve`
 * / `resolveTx`, and the raw `tx.execute(sql\`…\`)` template for `cancelTx` /
 * `cancelOpenForConversaTx`. So a missing tenant/agent binding is observable as
 * a foreign tenant's row being mutated — the exact regression lever.
 *
 * Each test seeds tenant-A + tenant-B rows that SHARE the targeted
 * id/conversa_id, runs the method under tenant-A's context, and asserts:
 *   (1) ONLY tenant-A's row changed (tenant-B untouched), and
 *   (2) the executed WHERE actually bound BOTH `tenant_id` AND `agent_id`
 *       (revert-check: a refactor that drops either binding fails here even if
 *       the row-state assertion happened to pass for a given seed).
 *
 * Pre-fix revert-check: against the old id-only / conversa_id-only predicate the
 * shared-id rows BOTH match, so assertion (1) fails (tenant-B's row is mutated)
 * and assertion (2) fails (no tenant/agent term is present).
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
// methods run their drizzle UPDATE / raw `execute` against this. `withTx` hands
// the SAME store object back as the `tx`, so the tx-aware methods
// (`resolveTx`/`cancelTx`/`cancelOpenForConversaTx`) operate on it too.
const store: TenantScopedUpdateStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: store.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

// A helper row: open `aberta` unless overridden. `expira_em` in the future so
// it is never treated as due by any predicate.
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const openRow = (over: Partial<StoreRow>): StoreRow => ({
  id: 'pq',
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  conversa_id: 'conv-shared',
  status: 'aberta',
  expira_em: FUTURE,
  ...over,
});

beforeEach(() => {
  store.reset([]);
});

/**
 * Assert the builder-path WHERE (captured from `.where(...)`) carries BOTH the
 * tenant and agent equality bindings for tenant-A.
 */
function expectBuilderBoundTenantAgent(): void {
  const terms = parsePredicateForTest(store.lastPredicate());
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
}

/**
 * Assert the raw-SQL WHERE (parsed from the most recent `execute(sql\`…\`)`)
 * carries BOTH the tenant and agent equality bindings for tenant-A.
 */
function expectRawBoundTenantAgent(): void {
  const terms = store.lastExecuteTerms() ?? [];
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
}

describe('#355 H2 — pendingQuestionsRepo.resolve() resolves ONLY the current tenant/agent', () => {
  it('running resolve() under tenant-A leaves tenant-B (and other-agent) rows UNTOUCHED', async () => {
    store.reset([
      openRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // Same id, different tenant — MUST stay untouched.
      openRow({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Same id + tenant, different agent — MUST stay untouched (scope is the
      // full (tenant_id, agent_id) tuple).
      openRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      pendingQuestionsRepo.resolve('shared', { decision: 'aprova' }),
    );

    const rowsWithId = store.rows.filter((r) => r.id === 'shared');
    const a = rowsWithId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!;
    const b = rowsWithId.find((r) => r.tenant_id === 'tenant-B')!;
    const z = rowsWithId.find((r) => r.agent_id === 'agent-Z')!;
    expect(a.status).toBe('respondida');
    expect(b.status).toBe('aberta'); // cross-tenant isolation
    expect(z.status).toBe('aberta'); // cross-agent isolation
    expectBuilderBoundTenantAgent();
  });

  it('FAIL-LOUD — throws when no row matches the current tenant/agent (cross-tenant misroute)', async () => {
    // Only tenant-B owns the id. Running under tenant-A matches 0 rows → the
    // single-row method must throw rather than silently no-op.
    store.reset([openRow({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => pendingQuestionsRepo.resolve('b-only', { decision: 'aprova' })),
    ).rejects.toThrow(/resolve matched 0 rows/);
    // tenant-B's row was NOT touched by the failed tenant-A call.
    expect(store.rows.find((r) => r.id === 'b-only')!.status).toBe('aberta');
  });
});

describe('#355 H2 — pendingQuestionsRepo.resolveTx() resolves ONLY the current tenant/agent', () => {
  it('running resolveTx() under tenant-A leaves tenant-B rows UNTOUCHED', async () => {
    store.reset([
      openRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      openRow({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      pendingQuestionsRepo.resolveTx(store.db as never, 'shared', { option_chosen: 'sim' }),
    );

    const rowsWithId = store.rows.filter((r) => r.id === 'shared');
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-A')!.status).toBe('respondida');
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-B')!.status).toBe('aberta');
    expectBuilderBoundTenantAgent();
  });

  it('FAIL-LOUD — throws when the locked row is not owned by the current tenant/agent', async () => {
    store.reset([openRow({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () =>
        pendingQuestionsRepo.resolveTx(store.db as never, 'b-only', { option_chosen: 'sim' }),
      ),
    ).rejects.toThrow(/resolveTx matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.status).toBe('aberta');
  });
});

describe('#355 H2 — pendingQuestionsRepo.cancelTx() cancels ONLY the current tenant/agent', () => {
  it('running cancelTx() under tenant-A leaves tenant-B rows UNTOUCHED', async () => {
    store.reset([
      openRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      openRow({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      pendingQuestionsRepo.cancelTx(store.db as never, 'shared', 'user_cancelled'),
    );

    const rowsWithId = store.rows.filter((r) => r.id === 'shared');
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-A')!.status).toBe('cancelada');
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-B')!.status).toBe('aberta');
    expectRawBoundTenantAgent();
  });

  it('FAIL-LOUD — throws when the locked row is not owned by the current tenant/agent', async () => {
    store.reset([openRow({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () =>
        pendingQuestionsRepo.cancelTx(store.db as never, 'b-only', 'user_cancelled'),
      ),
    ).rejects.toThrow(/cancelTx matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.status).toBe('aberta');
  });
});

describe('#355 H2 — pendingQuestionsRepo.cancelOpenForConversaTx() cancels ONLY the current tenant/agent', () => {
  it('running under tenant-A cancels A-open on the shared conversa, leaves B-open UNTOUCHED', async () => {
    store.reset([
      // Same conversa_id across tenants (a conversa id collision in the
      // multi-tenant world). Only tenant-A's open question may be cancelled.
      openRow({ id: 'A-open', tenant_id: 'tenant-A', agent_id: 'agent-A', conversa_id: 'conv-x' }),
      openRow({ id: 'B-open', tenant_id: 'tenant-B', agent_id: 'agent-B', conversa_id: 'conv-x' }),
      // tenant-A but a different agent on the same conversa — untouched.
      openRow({ id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z', conversa_id: 'conv-x' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      pendingQuestionsRepo.cancelOpenForConversaTx(store.db as never, 'conv-x', 'substituted'),
    );

    expect(out.cancelled_ids).toEqual(['A-open']);
    const byId = (id: string) => store.rows.find((r) => r.id === id)!;
    expect(byId('A-open').status).toBe('cancelada');
    expect(byId('B-open').status).toBe('aberta'); // cross-tenant isolation
    expect(byId('A-otherAgent').status).toBe('aberta'); // cross-agent isolation
    expectRawBoundTenantAgent();
  });

  it('PREDICATE-ONLY — a 0-row outcome is a legitimate no-op (no throw)', async () => {
    // No open question for tenant-A on this conversa (only tenant-B has one).
    // The BULK cancel must return an empty list WITHOUT throwing.
    store.reset([
      openRow({ id: 'B-open', tenant_id: 'tenant-B', agent_id: 'agent-B', conversa_id: 'conv-y' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      pendingQuestionsRepo.cancelOpenForConversaTx(store.db as never, 'conv-y', 'substituted'),
    );

    expect(out.cancelled_ids).toEqual([]);
    // tenant-B's row stays open (never matched).
    expect(store.rows.find((r) => r.id === 'B-open')!.status).toBe('aberta');
    expectRawBoundTenantAgent();
  });

  it('only ABERTA rows are cancelled (status gate preserved alongside the tenant predicate)', async () => {
    store.reset([
      openRow({ id: 'A-open', tenant_id: 'tenant-A', agent_id: 'agent-A', conversa_id: 'conv-z' }),
      openRow({
        id: 'A-resolved',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        conversa_id: 'conv-z',
        status: 'respondida',
      }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      pendingQuestionsRepo.cancelOpenForConversaTx(store.db as never, 'conv-z', 'substituted'),
    );

    expect(out.cancelled_ids).toEqual(['A-open']);
    expect(store.rows.find((r) => r.id === 'A-resolved')!.status).toBe('respondida');
  });
});
