/**
 * Issue #355 (H3 of #323) — MUTATION ISOLATION for the two FINANCIAL
 * `repositories.ts` single-row-by-id writes that move money:
 *   - `contasRepo.addToBalance`   (UPDATE saldo_atual = saldo_atual + delta)
 *   - `transacoesRepo.update`     (UPDATE a transaction's lifecycle/fields)
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * H1 (#357) hardened the conversas/mensagens hot-path mutations and H2 (#361)
 * the `pendingQuestionsRepo` ones; this H3 closes the analogous gap on the
 * FINANCIAL writes. Both were scoped ONLY by `id` with NO tenant predicate, so
 * once multi-tenant a caller (or a stale/foreign id) could write across the
 * tenant boundary — and because these write account balances + transactions, a
 * silent missed/misrouted update is corrupted money. After the fix each carries
 * a `tenant_id = <ALS> AND agent_id = <ALS>` predicate AND is FAIL-LOUD (throws
 * on a 0-row context mismatch), mirroring `mensagensRepo.markProcessed` /
 * `pendingQuestionsRepo.resolve`.
 *
 * This spec drives the REAL repo methods against an in-memory store keyed by
 * tenant (`makeTenantScopedUpdateStore`) whose UPDATE is applied by EVALUATING
 * the method's actual drizzle WHERE clause — so a missing tenant/agent binding is
 * observable as a foreign tenant's row being mutated (the exact regression lever).
 *
 * Each test seeds tenant-A + tenant-B rows that SHARE the targeted id, runs the
 * method under tenant-A's context, and asserts:
 *   (1) ONLY tenant-A's row matched (tenant-B + other-agent untouched), and
 *   (2) the executed WHERE actually bound BOTH `tenant_id` AND `agent_id`
 *       (revert-check: a refactor that drops either binding fails here even if
 *       the row-state assertion happened to pass for a given seed).
 *
 * Pre-fix revert-check: against the old id-only predicate the shared-id rows
 * BOTH match, so assertion (1) fails (tenant-B's row is mutated) and assertion
 * (2) fails (no tenant/agent term is present); and the FAIL-LOUD specs flip from
 * "throws" to "silently no-ops".
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
// methods run their drizzle UPDATE against this.
const store: TenantScopedUpdateStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: store.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

beforeEach(() => {
  store.reset([]);
});

/**
 * Assert the builder-path WHERE (captured from `.where(...)`) carries BOTH the
 * tenant and agent equality bindings for tenant-A. Both methods under test use
 * the drizzle builder (`db.update(...).set(...).where(and(...))`), so this is the
 * single revert-check both share.
 */
function expectBoundTenantAgent(): void {
  const terms = parsePredicateForTest(store.lastPredicate());
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
}

// A `contas_bancarias` row. `saldo_atual` is a NUMBER sentinel so we can prove a
// foreign row was untouched: the store's `Object.assign(row, patch)` overwrites a
// MATCHED row's `saldo_atual` with the `sql\`saldo_atual + delta\`` node (not a
// number), so "still a number" ⇔ "never matched" — exactly the isolation signal.
const contaRow = (over: Partial<StoreRow>): StoreRow => ({
  id: 'conta',
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  status: 'ativa',
  saldo_atual: 100,
  ...over,
});

// A `transacoes` row. `status` starts 'paga'; a matched `update({status:'cancelada'})`
// flips it to 'cancelada', an untouched row stays 'paga'.
const transacaoRow = (over: Partial<StoreRow>): StoreRow => ({
  id: 'tx',
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  status: 'paga',
  ...over,
});

describe('#355 H3 — contasRepo.addToBalance() adjusts ONLY the current tenant/agent', () => {
  it('running addToBalance() under tenant-A leaves tenant-B (and other-agent) accounts UNTOUCHED', async () => {
    store.reset([
      contaRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A', saldo_atual: 100 }),
      // Same id, different tenant — MUST stay untouched (cross-tenant isolation).
      contaRow({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B', saldo_atual: 200 }),
      // Same id + tenant, different agent — MUST stay untouched (scope is the
      // full (tenant_id, agent_id) tuple).
      contaRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z', saldo_atual: 300 }),
    ]);
    const { contasRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => contasRepo.addToBalance('shared', 50));

    const rowsWithId = store.rows.filter((r) => r.id === 'shared');
    const a = rowsWithId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!;
    const b = rowsWithId.find((r) => r.tenant_id === 'tenant-B')!;
    const z = rowsWithId.find((r) => r.agent_id === 'agent-Z')!;
    // A matched: its saldo_atual was overwritten with the `saldo_atual + delta`
    // SQL node (no longer the original NUMBER 100).
    expect(typeof a.saldo_atual).not.toBe('number');
    // B + Z never matched → balances are the untouched original numbers.
    expect(b.saldo_atual).toBe(200); // cross-tenant isolation
    expect(z.saldo_atual).toBe(300); // cross-agent isolation
    expectBoundTenantAgent();
  });

  it('FAIL-LOUD — throws when no account matches the current tenant/agent (cross-tenant misroute)', async () => {
    // Only tenant-B owns the id. Running under tenant-A matches 0 rows → the
    // FINANCIAL single-row write must throw rather than silently return null
    // (a silent miss = balance un-incremented while its transaction committed).
    store.reset([contaRow({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B', saldo_atual: 200 })]);
    const { contasRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => contasRepo.addToBalance('b-only', 50)),
    ).rejects.toThrow(/addToBalance matched 0 rows/);
    // tenant-B's balance was NOT touched by the failed tenant-A call.
    expect(store.rows.find((r) => r.id === 'b-only')!.saldo_atual).toBe(200);
  });
});

describe('#355 H3 — transacoesRepo.update() patches ONLY the current tenant/agent', () => {
  it('running update() under tenant-A leaves tenant-B (and other-agent) transactions UNTOUCHED', async () => {
    store.reset([
      transacaoRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // Same id, different tenant — MUST stay untouched (cross-tenant isolation).
      transacaoRow({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Same id + tenant, different agent — MUST stay untouched.
      transacaoRow({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { transacoesRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      transacoesRepo.update('shared', { status: 'cancelada' }),
    );

    const rowsWithId = store.rows.filter((r) => r.id === 'shared');
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!.status).toBe(
      'cancelada',
    );
    expect(rowsWithId.find((r) => r.tenant_id === 'tenant-B')!.status).toBe('paga'); // cross-tenant
    expect(rowsWithId.find((r) => r.agent_id === 'agent-Z')!.status).toBe('paga'); // cross-agent
    expectBoundTenantAgent();
  });

  it('FAIL-LOUD — throws when no transaction matches the current tenant/agent (cross-tenant misroute)', async () => {
    // Only tenant-B owns the id. Running under tenant-A matches 0 rows → the
    // method must throw rather than silently no-op (which would report the
    // cancel as succeeded while the transaction stayed active).
    store.reset([transacaoRow({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { transacoesRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => transacoesRepo.update('b-only', { status: 'cancelada' })),
    ).rejects.toThrow(/update matched 0 rows/);
    // tenant-B's transaction was NOT touched by the failed tenant-A call.
    expect(store.rows.find((r) => r.id === 'b-only')!.status).toBe('paga');
  });
});
