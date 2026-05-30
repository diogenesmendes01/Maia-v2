/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `pending-expirer` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runPendingExpirer` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples with EITHER a due pending_question OR a due
 *      dual-approval workflow
 *      (`pendingQuestionsRepo.listTenantAgentPairsWithDueExpirations`) and runs
 *      the inner (`expireAll()` + `expireDueDualApprovals()`) ONCE PER tuple
 *      inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist
 *      NEITHER inner call runs under `default`.
 *
 *   3. BOTH inner operations run under the SAME routed tuple per iteration
 *      (pending-question expiry + dual-approval expiry are not split across
 *      contexts) — and dual-approval is exercised, proving the UNION arm matters.
 *
 *   4. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   5. MUTATION ISOLATION (the test that would have caught the #345 review bug):
 *      `pendingQuestionsRepo.expireDue()`'s UPDATE is scoped to the CURRENT
 *      (tenant_id, agent_id). Running it under tenant-A's context expires ONLY
 *      tenant-A's due pending_questions and leaves tenant-B's rows UNTOUCHED —
 *      proved against an in-memory store keyed by tenant whose UPDATE is applied
 *      via the REAL drizzle WHERE predicate (so the bound tenant/agent params
 *      are exercised, not asserted away). Before the fix the predicate carried
 *      no tenant binding, so tenant-B's due row would have been expired too.
 *
 * Strategy: the DISPATCH-routing block mocks `@/db/repositories.js` for the
 * enumeration and the two workflow modules so each inner call captures the
 * ACTIVE tenant context. The MUTATION-ISOLATION block instead drives the REAL
 * `pendingQuestionsRepo.expireDue()` (kept via `importOriginal`; only the
 * enumeration helper is overridden) against a store-backed `@/db/client.js`
 * mock that evaluates the actual drizzle predicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
const expireAllContexts: Pair[] = [];
const expireDualContexts: Pair[] = [];
/** Per-tuple return values keyed `tenant|agent`. */
let tableCountByTuple: Record<string, number> = {};
let dualCountByTuple: Record<string, number> = {};
let throwExpireAllForTuple: Set<string> = new Set();

const listDuePairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

const expireAllMock = vi.fn(async (): Promise<{ table: number; conversas: number }> => {
  const ctx = tryGetCurrentContext();
  if (!ctx) throw new Error('expireAll ran outside tenant context — repo would throw in prod');
  expireAllContexts.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwExpireAllForTuple.has(key)) throw new Error(`synthetic expireAll failure for ${key}`);
  return { table: tableCountByTuple[key] ?? 0, conversas: 0 };
});

const expireDualMock = vi.fn(async (): Promise<number> => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error('expireDueDualApprovals ran outside tenant context — repo would throw in prod');
  }
  expireDualContexts.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  return dualCountByTuple[key] ?? 0;
});

// In-memory, tenant-keyed store standing in for `@/db/client.js`. The REAL
// `pendingQuestionsRepo.expireDue()` runs its drizzle UPDATE against this in the
// MUTATION-ISOLATION block; the DISPATCH-routing block never touches it (it
// mocks `expireAll`), so the store stays dormant there.
const mutationStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: mutationStore.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(mutationStore.db),
}));

// Keep the REAL repo (so `expireDue`'s WHERE predicate is exercised) and
// override ONLY the dispatcher-enumeration helper used by the routing tests.
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    pendingQuestionsRepo: {
      ...actual.pendingQuestionsRepo,
      listTenantAgentPairsWithDueExpirations: listDuePairsMock,
    },
  };
});

vi.mock('@/workflows/pending-questions.js', () => ({
  expireAll: expireAllMock,
}));

vi.mock('@/workflows/dual-approval.js', () => ({
  expireDueDualApprovals: expireDualMock,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  expireAllContexts.length = 0;
  expireDualContexts.length = 0;
  tableCountByTuple = {};
  dualCountByTuple = {};
  throwExpireAllForTuple = new Set();
  listDuePairsMock.mockClear();
  expireAllMock.mockClear();
  expireDualMock.mockClear();
});

describe('Issue #345 — runPendingExpirer is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — both inner ops run once per tuple, each under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    expect(listDuePairsMock).toHaveBeenCalledTimes(1);
    expect(expireAllMock).toHaveBeenCalledTimes(2);
    expect(expireDualMock).toHaveBeenCalledTimes(2);

    const allSeen = new Set(expireAllContexts.map((c) => `${c.tenant_id}|${c.agent_id}`));
    const dualSeen = new Set(expireDualContexts.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(allSeen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    expect(dualSeen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('PAIRED — pending-question + dual-approval expiry share the SAME routed tuple per iteration', async () => {
    enumeratedPairs = [A, B];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    // For each iteration the expireAll context and the expireDual context are
    // the same tuple (not a tenant-A pending paired with a tenant-B dual).
    expect(expireAllContexts).toEqual(expireDualContexts);
  });

  it('NO default/default — neither inner op runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    for (const c of [...expireAllContexts, ...expireDualContexts]) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('DUAL-APPROVAL-ONLY tuple — a tenant whose only due work is a dual-approval is still processed', async () => {
    // The UNION arm is load-bearing: tenant-B is enumerated purely because of a
    // due dual-approval (no due pending_question). It must still get its inner.
    enumeratedPairs = [B];
    dualCountByTuple = { 'tenant-B|agent-B': 1 };

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    expect(expireDualContexts).toEqual([B]);
    expect(expireAllContexts).toEqual([B]);
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    expect(expireAllContexts).toEqual([DEFAULT]);
    expect(expireDualContexts).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (neither inner op invoked)', async () => {
    enumeratedPairs = [];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runPendingExpirer();

    expect(expireAllMock).not.toHaveBeenCalled();
    expect(expireDualMock).not.toHaveBeenCalled();
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwExpireAllForTuple = new Set(['tenant-A|agent-A']);
    dualCountByTuple = { 'tenant-B|agent-B': 2 };

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await expect(runPendingExpirer()).resolves.toBeUndefined();

    // tenant-B's inner still ran fully (both ops) despite tenant-A throwing in
    // expireAll (which aborts only tenant-A's iteration).
    expect(expireDualContexts).toEqual([B]);
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await expect(runPendingExpirer()).resolves.toBeUndefined();
    expect(expireAllContexts).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runPendingExpirer } = await import('@/workers/pending-expirer.js');
    await runWithTenantContext(A, runPendingExpirer);

    expect(expireAllContexts).toEqual([B]);
    expect(expireDualContexts).toEqual([B]);
  });
});

/**
 * MUTATION ISOLATION — exercises the REAL `pendingQuestionsRepo.expireDue()`
 * UPDATE against an in-memory store keyed by tenant. This is the regression
 * lever for the #345 review finding: the worker now runs `expireDue` per
 * enumerated tuple, so its WHERE clause MUST be scoped to the current
 * (tenant_id, agent_id) or it would expire every tenant's due rows on the first
 * pass. The store applies the UPDATE by evaluating the actual drizzle predicate,
 * so a missing tenant binding is observable as tenant-B's rows being mutated.
 */
describe('Issue #345 — pendingQuestionsRepo.expireDue() expires ONLY the current tenant/agent', () => {
  // A row helper: due (past `expira_em`) + `aberta` unless overridden.
  const PAST = new Date(Date.now() - 60_000).toISOString();
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  const dueRow = (over: Partial<StoreRow>): StoreRow => ({
    id: 'pq',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'aberta',
    expira_em: PAST,
    ...over,
  });

  beforeEach(() => {
    mutationStore.reset([
      // Tenant A: one due+open question (SHOULD expire when running as A).
      dueRow({ id: 'A-due', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // Tenant B: same shape, different tenant (MUST stay untouched).
      dueRow({ id: 'B-due', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Tenant A but a DIFFERENT agent (MUST stay untouched — scoping is by the
      // full (tenant_id, agent_id) tuple the enumeration partitions on).
      dueRow({ id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
  });

  it('running expireDue() under tenant-A leaves tenant-B (and other-agent) rows UNTOUCHED', async () => {
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const expired = await runWithTenantContext(A, () => pendingQuestionsRepo.expireDue());

    // Only tenant-A/agent-A's due row was expired.
    expect(expired).toBe(1);
    const byId = (id: string) => mutationStore.rows.find((r) => r.id === id)!;
    expect(byId('A-due').status).toBe('expirada');
    // Cross-tenant isolation: tenant-B's row is untouched …
    expect(byId('B-due').status).toBe('aberta');
    // … and so is tenant-A's OTHER agent.
    expect(byId('A-otherAgent').status).toBe('aberta');

    // The WHERE predicate actually bound tenant_id AND agent_id (defence against
    // a future refactor that scopes by only one of them).
    const terms = parsePredicateForTest(mutationStore.lastPredicate());
    expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
  });

  it('does NOT expire a row whose `expira_em` is still in the future (predicate honoured per tenant)', async () => {
    mutationStore.reset([
      dueRow({ id: 'A-future', tenant_id: 'tenant-A', agent_id: 'agent-A', expira_em: FUTURE }),
      dueRow({ id: 'A-due', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      dueRow({ id: 'B-due', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    ]);
    const { pendingQuestionsRepo } = await import('@/db/repositories.js');

    const expired = await runWithTenantContext(A, () => pendingQuestionsRepo.expireDue());

    expect(expired).toBe(1);
    const byId = (id: string) => mutationStore.rows.find((r) => r.id === id)!;
    expect(byId('A-due').status).toBe('expirada');
    expect(byId('A-future').status).toBe('aberta'); // not yet due
    expect(byId('B-due').status).toBe('aberta'); // other tenant
  });
});
