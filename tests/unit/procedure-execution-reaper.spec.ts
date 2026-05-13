/**
 * P3c Task 9 — worker `procedure-execution-reaper`.
 *
 * Behavior:
 *   - Periodic worker (cron 0 * * * *) that scans `procedure_executions` per
 *     tenant. For each row with `status='in_progress' AND last_activity_at <
 *     now() - INTERVAL X days` (default X=7, env PROCEDURE_TTL_DAYS), it:
 *       1. Appends event `auto_abandoned` for audit trail.
 *       2. Updates execution: status='abandoned', outcome='no_response',
 *          ended_at=now().
 *
 * Spec criterion: "Worker reaper força status=abandoned após 7d de inatividade".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory state mirroring the pattern used by other procedure spec files.
const tenantsState: Array<{ id: string; nome: string; status: string }> = [];
// Keyed per (tenant_id, execution.id) so the reaper's filter has to do
// its job per-tenant. listStaleInProgress only returns rows whose tenant
// matches the current tenant context AND status/ttl predicates hold.
const executionsState: Record<string, any> = {};
const eventsLog: any[] = [];

// PR #85 fix P85-I1 — reaper now wraps event+status in withTx. Mock it as
// a passthrough so the existing repo mocks (which mutate in-memory state)
// continue to drive assertions. Real DB tx behaviour is covered by
// integration tests; here we just verify the worker still emits the
// expected logical writes.
vi.mock('@/db/client.js', () => ({
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    tenantsRepo: {
      list: vi.fn(async () => tenantsState.slice()),
      findById: vi.fn(async (id: string) => tenantsState.find((t) => t.id === id) ?? null),
      create: vi.fn(),
    },
    procedureExecutionsRepo: {
      listStaleInProgress: vi.fn(async (opts: { ttl_days: number; limit?: number }) => {
        // Read current tenant from context — the worker MUST set tenant context
        // via runWithTenantContext before calling this.
        const { getCurrentTenant } = await import('@/db/tenant-context.js');
        const tenant_id = getCurrentTenant();
        const cutoff = Date.now() - opts.ttl_days * 86_400_000;
        const all = Object.values(executionsState).filter((ex: any) => {
          if (ex.tenant_id !== tenant_id) return false;
          if (ex.status !== 'in_progress') return false;
          const lastTs =
            ex.last_activity_at instanceof Date
              ? ex.last_activity_at.getTime()
              : new Date(ex.last_activity_at).getTime();
          return lastTs < cutoff;
        });
        // Honour the worker's batch limit (P85-I6).
        return typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all;
      }),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (executionsState[id]) {
          executionsState[id] = {
            ...executionsState[id],
            ...updates,
            last_activity_at: new Date(),
          };
        }
      }),
      // Tx-variant used by the post-fix reaper. Same semantics as updateState
      // in this in-memory mock — the real implementation forwards through tx.
      updateStateTx: vi.fn(async (_tx: unknown, id: string, updates: any) => {
        if (executionsState[id]) {
          executionsState[id] = {
            ...executionsState[id],
            ...updates,
            last_activity_at: new Date(),
          };
        }
      }),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => {
        eventsLog.push({ ...input, created_at: new Date() });
      }),
      // Tx-variant used by the post-fix reaper.
      recordTx: vi.fn(async (_tx: unknown, input: any) => {
        eventsLog.push({ ...input, created_at: new Date() });
      }),
    },
  };
});

import { runProcedureExecutionReaper } from '@/workers/procedure-execution-reaper.js';

function seedExecution(overrides: Partial<any> & { id: string; tenant_id: string }) {
  const row = {
    agent_id: 'default',
    conversa_id: 'conv-1',
    definition_id: 'def-1',
    definition_version: 1,
    status: 'in_progress',
    current_step_id: 'step-1',
    execution_state: {},
    completed_steps: [],
    started_at: new Date(),
    last_activity_at: new Date(),
    ended_at: null,
    outcome: null,
    notes: null,
    ...overrides,
  };
  executionsState[overrides.id] = row;
  return row;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

describe('runProcedureExecutionReaper', () => {
  beforeEach(() => {
    tenantsState.length = 0;
    for (const k of Object.keys(executionsState)) delete executionsState[k];
    eventsLog.length = 0;
    vi.clearAllMocks();
    delete process.env.PROCEDURE_TTL_DAYS;
  });

  it('cenário 1: 1 stale in_progress execution → appends auto_abandoned event AND sets status=abandoned/no_response', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    seedExecution({
      id: 'exec-stale',
      tenant_id: 'tenant-a',
      status: 'in_progress',
      last_activity_at: daysAgo(8),
      current_step_id: 'step-x',
    });

    await runProcedureExecutionReaper();

    // Event appended with type=auto_abandoned, carrying step_id + payload.
    expect(eventsLog).toHaveLength(1);
    expect(eventsLog[0].execution_id).toBe('exec-stale');
    expect(eventsLog[0].event_type).toBe('auto_abandoned');
    expect(eventsLog[0].step_id).toBe('step-x');
    expect(eventsLog[0].payload.reason).toMatch(/inactive_for_\d+_days/);
    expect(eventsLog[0].payload.last_activity_at).toBeDefined();

    // Execution updated to abandoned/no_response with ended_at set.
    const updated = executionsState['exec-stale'];
    expect(updated.status).toBe('abandoned');
    expect(updated.outcome).toBe('no_response');
    expect(updated.ended_at).toBeInstanceOf(Date);
  });

  it('cenário 2: fresh execution (last_activity_at recente) → reaper NÃO toca', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    seedExecution({
      id: 'exec-fresh',
      tenant_id: 'tenant-a',
      status: 'in_progress',
      last_activity_at: daysAgo(1), // 1 day old — well under 7d TTL
    });

    await runProcedureExecutionReaper();

    expect(eventsLog).toHaveLength(0);
    expect(executionsState['exec-fresh'].status).toBe('in_progress');
    expect(executionsState['exec-fresh'].outcome).toBeNull();
    expect(executionsState['exec-fresh'].ended_at).toBeNull();
  });

  it('cenário 3: execução já completed/aborted → reaper ignora (listStaleInProgress filtra por in_progress)', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    seedExecution({
      id: 'exec-completed',
      tenant_id: 'tenant-a',
      status: 'completed',
      outcome: 'success',
      last_activity_at: daysAgo(30), // ancient — but status=completed
      ended_at: daysAgo(30),
    });
    seedExecution({
      id: 'exec-aborted',
      tenant_id: 'tenant-a',
      status: 'aborted',
      outcome: 'user_cancelled',
      last_activity_at: daysAgo(30),
      ended_at: daysAgo(30),
    });

    await runProcedureExecutionReaper();

    expect(eventsLog).toHaveLength(0);
    expect(executionsState['exec-completed'].status).toBe('completed');
    expect(executionsState['exec-completed'].outcome).toBe('success');
    expect(executionsState['exec-aborted'].status).toBe('aborted');
    expect(executionsState['exec-aborted'].outcome).toBe('user_cancelled');
  });

  it('cenário 4: múltiplos tenants → reaper itera todos e isola por tenant', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    tenantsState.push({ id: 'tenant-b', nome: 'B', status: 'active' });

    seedExecution({
      id: 'exec-a-stale',
      tenant_id: 'tenant-a',
      status: 'in_progress',
      last_activity_at: daysAgo(10),
    });
    seedExecution({
      id: 'exec-b-stale',
      tenant_id: 'tenant-b',
      status: 'in_progress',
      last_activity_at: daysAgo(9),
    });
    seedExecution({
      id: 'exec-b-fresh',
      tenant_id: 'tenant-b',
      status: 'in_progress',
      last_activity_at: daysAgo(2),
    });

    await runProcedureExecutionReaper();

    // Both stale rows reaped, fresh row untouched.
    expect(eventsLog).toHaveLength(2);
    const reapedIds = eventsLog.map((e) => e.execution_id).sort();
    expect(reapedIds).toEqual(['exec-a-stale', 'exec-b-stale']);

    expect(executionsState['exec-a-stale'].status).toBe('abandoned');
    expect(executionsState['exec-b-stale'].status).toBe('abandoned');
    expect(executionsState['exec-b-fresh'].status).toBe('in_progress');
  });

  it('cenário 5: TTL customizado via PROCEDURE_TTL_DAYS=14 → exec de 8d NÃO é reaped', async () => {
    // Set env BEFORE module evaluates the constant. The worker reads
    // process.env.PROCEDURE_TTL_DAYS at module load time, so we have to
    // re-import via resetModules to pick up the new value.
    process.env.PROCEDURE_TTL_DAYS = '14';
    vi.resetModules();
    const mod = await import('@/workers/procedure-execution-reaper.js');

    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    seedExecution({
      id: 'exec-8d',
      tenant_id: 'tenant-a',
      status: 'in_progress',
      last_activity_at: daysAgo(8),
    });

    await mod.runProcedureExecutionReaper();

    expect(eventsLog).toHaveLength(0);
    expect(executionsState['exec-8d'].status).toBe('in_progress');
  });
});
