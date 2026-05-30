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
 * Strategy: mock `@/db/repositories.js` for the enumeration and the two workflow
 * modules so each inner call captures the ACTIVE tenant context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

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

vi.mock('@/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    listTenantAgentPairsWithDueExpirations: listDuePairsMock,
  },
}));

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
