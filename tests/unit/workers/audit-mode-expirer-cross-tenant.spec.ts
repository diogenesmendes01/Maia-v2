/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `audit-mode-expirer` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runAuditModeExpirer` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples owning a pessoa with an expirable audit-mode
 *      pref (`pessoasRepo.listTenantAgentPairsWithExpiredAuditMode`) and runs
 *      `expireAuditModes()` ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist NO
 *      `expireAuditModes()` invocation runs under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode: the lone `('default','default')`
 *      tuple still runs the inner once under default.
 *
 *   4. Empty enumeration → clean no-op (inner never invoked).
 *
 *   5. Fail-isolated: a throw under tenant-A does not block tenant-B.
 *
 * Strategy: mock `@/db/repositories.js` for the enumeration and
 * `@/governance/audit-mode.js` so `expireAuditModes()` captures the ACTIVE
 * tenant context (proving the worker opened the right scope) instead of touching
 * the DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
const contextsSeen: Pair[] = [];
/** Per-tuple expired count returned by the mocked inner (keyed `tenant|agent`). */
let expiredCountByTuple: Record<string, number> = {};
let throwForTuple: Set<string> = new Set();

const listExpiredAuditPairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

const expireAuditModesMock = vi.fn(async (): Promise<number> => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'expireAuditModes ran outside tenant context — pessoasRepo.list would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic audit-mode failure for ${key}`);
  return expiredCountByTuple[key] ?? 0;
});

vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: {
    listTenantAgentPairsWithExpiredAuditMode: listExpiredAuditPairsMock,
  },
}));

vi.mock('@/governance/audit-mode.js', () => ({
  expireAuditModes: expireAuditModesMock,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  expiredCountByTuple = {};
  throwForTuple = new Set();
  listExpiredAuditPairsMock.mockClear();
  expireAuditModesMock.mockClear();
});

describe('Issue #345 — runAuditModeExpirer is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — expireAuditModes runs once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await runAuditModeExpirer();

    expect(listExpiredAuditPairsMock).toHaveBeenCalledTimes(1);
    expect(expireAuditModesMock).toHaveBeenCalledTimes(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — inner never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await runAuditModeExpirer();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await runAuditModeExpirer();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (inner never invoked)', async () => {
    enumeratedPairs = [];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await runAuditModeExpirer();

    expect(expireAuditModesMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);
    expiredCountByTuple = { 'tenant-B|agent-B': 3 };

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await expect(runAuditModeExpirer()).resolves.toBeUndefined();

    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    // tenant-B was processed despite tenant-A throwing.
    expect(expireAuditModesMock).toHaveBeenCalledTimes(2);
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await expect(runAuditModeExpirer()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runAuditModeExpirer } = await import('@/workers/audit-mode-expirer.js');
    await runWithTenantContext(A, runAuditModeExpirer);

    expect(contextsSeen).toEqual([B]);
  });
});
