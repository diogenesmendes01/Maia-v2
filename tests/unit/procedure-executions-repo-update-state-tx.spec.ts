/**
 * Issue #323 review iteration-2 (BLOCKING 1) — unit tests for
 * `procedureExecutionsRepo.updateStateTx`.
 *
 * A prior fix tenant- AND agent-scoped the WHERE of this transactional write
 * (`and(eq(id), eq(tenant_id, getCurrentTenant()), eq(agent_id,
 * getCurrentAgent()))`). The re-review found that, with that predicate, an
 * UPDATE issued under a context whose (tenant_id, agent_id) does NOT match the
 * target row matches 0 rows and SILENTLY no-ops — the state transition
 * (complete/abort/advance/auto_abandon) is LOST. The old id-only WHERE always
 * matched, so a silent miss is a data-loss regression.
 *
 * FIX under test: updateStateTx now asserts it updated EXACTLY one row
 * (`.returning({ id })` + `.length === 1`, the same idiom as the sibling
 * compare-and-swap writes in repositories.ts) and THROWS a clear,
 * execution-id + tenant/agent-tagged error otherwise — turning a silent
 * lost-write into a loud, debuggable failure while preserving tenant
 * isolation.
 *
 * Strategy: mock `@/db/client.js` so the real repo runs against a fake `tx`
 * whose `update().set().where().returning()` chain resolves to a
 * test-controlled array. We assert the throw on a 0-row (mismatched
 * tenant/agent) update, the no-throw on a matching 1-row update — including the
 * legitimate single-tenant `default/default` path — and the defensive throw on
 * a >1-row update. The WHERE is also captured to confirm it stays scoped by
 * (id, tenant_id, agent_id).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const { recorder } = vi.hoisted(() => ({
  recorder: {
    // Rows the UPDATE ... RETURNING resolves to. Length drives the assertion:
    // 0 = context mismatch (no row), 1 = matched, >1 = defensive failure.
    returningRows: [] as Array<Record<string, unknown>>,
    setUpdates: [] as Array<Record<string, unknown>>,
    whereArgs: [] as unknown[],
  },
}));

// Capture-only flattener for the WHERE drizzle SQL object (mirrors the helper
// in outbound-messages-repo.spec.ts) so we can assert the scope columns.
function flattenChunks(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object') return String(arg);
  const qc = (arg as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(qc)) return qc.map((c) => flattenChunks(c)).join(' ');
  if (Array.isArray(arg)) return arg.map((c) => flattenChunks(c)).join(', ');
  const v = (arg as { value?: unknown }).value;
  if (v !== undefined) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
  }
  const name = (arg as { name?: string }).name;
  if (typeof name === 'string') return name;
  return '[opaque]';
}

vi.mock('@/db/client.js', () => {
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn((updates: Record<string, unknown>) => {
        recorder.setUpdates.push(updates);
        return {
          where: vi.fn((whereArg: unknown) => {
            recorder.whereArgs.push(whereArg);
            return {
              returning: vi.fn(async () => recorder.returningRows.slice()),
            };
          }),
        };
      }),
    })),
  };
  return {
    // updateStateTx receives `tx` from the caller; expose it as both the
    // bare `db` and the withTx passthrough so either entry compiles/runs.
    db: tx,
    withTx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    pool: {},
    isDbConnected: () => true,
    probeDb: async () => true,
    shutdownDb: async () => {},
  };
});

import { db } from '@/db/client.js';
import { procedureExecutionsRepo } from '@/db/repositories.js';

beforeEach(() => {
  vi.clearAllMocks();
  recorder.returningRows = [];
  recorder.setUpdates = [];
  recorder.whereArgs = [];
  // The default/default legitimacy test relies on the literal NOT being a hard
  // throw (flag off — the project default). Pin it so ambient env can't flip
  // the assertion. getCurrentTenant/Agent only throw on 'default' when
  // MAIA_REJECT_DEFAULT_LITERAL === 'true'.
  process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
});

describe('procedureExecutionsRepo.updateStateTx — exactly-one-row assertion (#323 BLOCKING 1)', () => {
  it('THROWS when the UPDATE matches 0 rows (tenant/agent context mismatch — silent lost-write turned loud)', async () => {
    // Simulate the dangerous case: the WHERE (id, tenant, agent) matched no row
    // because the caller's context does not own this execution. RETURNING is
    // empty → the assertion must fire instead of silently no-op'ing.
    recorder.returningRows = [];

    await expect(
      runWithTenantContext({ tenant_id: 'tenant-x', agent_id: 'agent-x' }, () =>
        procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
          status: 'completed',
          outcome: 'success',
        }),
      ),
    ).rejects.toThrow(/matched 0 rows/);
  });

  it('the thrown error names the execution id and the current tenant/agent', async () => {
    recorder.returningRows = [];
    await expect(
      runWithTenantContext({ tenant_id: 'tenant-x', agent_id: 'agent-x' }, () =>
        procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
          status: 'abandoned',
        }),
      ),
    ).rejects.toThrow(/exec-123.*tenant-x\/agent-x|tenant-x\/agent-x.*exec-123/);
  });

  it('RESOLVES (no throw) when the UPDATE matches exactly 1 row', async () => {
    recorder.returningRows = [{ id: 'exec-123' }];
    await expect(
      runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-1' }, () =>
        procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
          status: 'completed',
          outcome: 'success',
          ended_at: new Date(),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('does NOT break legitimate single-tenant default/default operation (row is default/default → matches, rowCount=1)', async () => {
    // The exact regression the reviewer asked to verify: under the legacy
    // default/default context the target row IS default/default, so the
    // predicate matches and RETURNING has 1 row → no throw.
    recorder.returningRows = [{ id: 'exec-default' }];
    await expect(
      runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () =>
        procedureExecutionsRepo.updateStateTx(db as any, 'exec-default', {
          status: 'completed',
          outcome: 'success',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('THROWS defensively when the UPDATE matches more than 1 row (assertion is exactly-one)', async () => {
    recorder.returningRows = [{ id: 'exec-123' }, { id: 'exec-123' }];
    await expect(
      runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-1' }, () =>
        procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
          status: 'completed',
        }),
      ),
    ).rejects.toThrow(/matched 2 rows/);
  });

  it('WHERE clause stays scoped by (id, tenant_id, agent_id) — tenant isolation preserved', async () => {
    recorder.returningRows = [{ id: 'exec-123' }];
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-1' }, () =>
      procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
        status: 'completed',
      }),
    );
    expect(recorder.whereArgs).toHaveLength(1);
    const whereSql = flattenChunks(recorder.whereArgs[0]);
    // All three scope columns must appear in the predicate.
    expect(whereSql).toContain('id');
    expect(whereSql).toContain('tenant_id');
    expect(whereSql).toContain('agent_id');
    // And the bound values for tenant/agent are the current context.
    expect(whereSql).toContain('tenant-a');
    expect(whereSql).toContain('agent-1');
    expect(whereSql).toContain('exec-123');
  });

  it('forces last_activity_at into the SET (touch on every transition)', async () => {
    recorder.returningRows = [{ id: 'exec-123' }];
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'agent-1' }, () =>
      procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', {
        status: 'completed',
      }),
    );
    expect(recorder.setUpdates).toHaveLength(1);
    expect(recorder.setUpdates[0]).toHaveProperty('last_activity_at');
    expect(recorder.setUpdates[0]!.status).toBe('completed');
  });

  it('throws MissingTenantContext when called outside a tenant context (defense-in-depth)', async () => {
    recorder.returningRows = [{ id: 'exec-123' }];
    await expect(
      procedureExecutionsRepo.updateStateTx(db as any, 'exec-123', { status: 'completed' }),
    ).rejects.toThrow(/Tenant context/);
  });
});
