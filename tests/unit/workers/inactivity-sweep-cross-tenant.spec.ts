/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `inactivity-sweep` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runInactivitySweep` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples with inactive-candidate permissions
 *      (`permissoesRepo.listTenantAgentPairsWithInactiveCandidates`) and runs
 *      the existing inner ONCE PER tuple inside
 *      `runWithTenantContext({ tenant_id, agent_id }, ...)`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist NO
 *      write/read lands under `default`. The inner's raw SQL UPDATE executes
 *      under the routed tuple (captured via `tryGetCurrentContext()` at the
 *      `db.execute` call site).
 *
 *   3. Behavior-preserving in single-tenant mode: when the only tuple is
 *      `('default','default')` the inner still runs once under that context.
 *
 *   4. Empty enumeration → clean no-op (no inner read, no context opened).
 *
 *   5. Fail-isolated: a throw under tenant-A does not block tenant-B.
 *
 * Strategy: mock `@/db/repositories.js` to control the enumeration result, and
 * mock `@/db/client.js` so the inner's `db.execute(UPDATE ...)` captures the
 * ACTIVE tenant context (proving the worker opened the right scope before the
 * mutation). The `audit()` call is mocked to a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Enumeration control + inner-context capture
// ---------------------------------------------------------------------------
type Pair = { tenant_id: string; agent_id: string };

/** Tuples the mocked dispatcher enumeration returns this test. */
let enumeratedPairs: Pair[] = [];
/** Context active each time the inner's UPDATE fires — the assertion lever. */
const contextsSeen: Pair[] = [];
/** Rows the mocked UPDATE returns per tuple (keyed by `tenant|agent`). */
let updateRowsByTuple: Record<string, Array<{ id: string; pessoa_id: string }>> = {};
/** When set for a `tenant|agent`, the inner UPDATE throws (fail-isolation). */
let throwForTuple: Set<string> = new Set();

const listInactivePairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

const dbExecuteMock = vi.fn(async (_query: SQL) => {
  // The inner is routed per (tenant, agent); capture the live ALS context so we
  // can prove the UPDATE ran under the right scope (defense-in-depth lever).
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'inactivity-sweep inner UPDATE ran outside tenant context — getCurrentTenant would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) {
    throw new Error(`synthetic inactivity-sweep failure for ${key}`);
  }
  return { rows: updateRowsByTuple[key] ?? [] };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

vi.mock('@/db/repositories.js', () => ({
  permissoesRepo: {
    listTenantAgentPairsWithInactiveCandidates: listInactivePairsMock,
  },
}));

const auditMock = vi.fn(async () => undefined);
vi.mock('@/governance/audit.js', () => ({
  audit: auditMock,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  updateRowsByTuple = {};
  throwForTuple = new Set();
  listInactivePairsMock.mockClear();
  dbExecuteMock.mockClear();
  auditMock.mockClear();
});

describe('Issue #345 — runInactivitySweep is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — inner runs once per enumerated tuple, each under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runInactivitySweep();

    expect(listInactivePairsMock).toHaveBeenCalledTimes(1);
    expect(contextsSeen).toHaveLength(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — no inner read lands under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runInactivitySweep();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    // Behavior-preservation: in legacy single-tenant data the enumeration yields
    // exactly the default tuple, so the inner still runs once under default.
    enumeratedPairs = [DEFAULT];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runInactivitySweep();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('audit() is called under the routed tuple for each suspended permission', async () => {
    enumeratedPairs = [A];
    updateRowsByTuple = {
      'tenant-A|agent-A': [
        { id: 'perm-1', pessoa_id: 'pessoa-1' },
        { id: 'perm-2', pessoa_id: 'pessoa-2' },
      ],
    };

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runInactivitySweep();

    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'permission_suspended_inactivity', alvo_id: 'perm-1' }),
    );
  });

  it('EMPTY enumeration → no-op (no inner UPDATE, no context opened)', async () => {
    enumeratedPairs = [];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runInactivitySweep();

    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);
    updateRowsByTuple = { 'tenant-B|agent-B': [{ id: 'perm-b', pessoa_id: 'pessoa-b' }] };

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await expect(runInactivitySweep()).resolves.toBeUndefined();

    // Both tuples were attempted (A threw, B succeeded).
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
    // tenant-B's audit still fired despite tenant-A blowing up.
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ alvo_id: 'perm-b' }),
    );
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    // The cron registry invokes the worker with NO active context — it IS the
    // dispatcher. No `runWithTenantContext` wrap at the call site.
    enumeratedPairs = [A];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await expect(runInactivitySweep()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not become a sticky default', async () => {
    // Even if an admin wraps the call in tenant-A, the dispatcher still routes
    // by the enumerated data (tenant-B), not the caller's ambient context.
    enumeratedPairs = [B];

    const { runInactivitySweep } = await import('@/workers/inactivity-sweep.js');
    await runWithTenantContext(A, runInactivitySweep);

    expect(contextsSeen).toEqual([B]);
  });
});
