/**
 * P3c Task 9 — worker `procedure-execution-reaper`.
 *
 * Behavior:
 *   - Periodic worker (cron 0 * * * *) that scans `procedure_executions` per
 *     (tenant, agent). For each row with `status='in_progress' AND
 *     last_activity_at < now() - INTERVAL X days` (default X=7, env
 *     PROCEDURE_TTL_DAYS), it:
 *       1. Appends event `auto_abandoned` for audit trail.
 *       2. Updates execution: status='abandoned', outcome='no_response',
 *          ended_at=now().
 *
 * Issue #323 (Phase 3) — per-agent fan-out: o worker enumera tuplas
 * (tenant_id, agent_id) DISTINCT com execuções `in_progress` e abre
 * `runWithTenantContext` por tupla REAL. `listStaleInProgress` agora filtra
 * por agent_id também, de modo que cada iteração processa só as execuções
 * daquele agent (e o event `auto_abandoned` é carimbado com o agent correto).
 *
 * Spec criterion: "Worker reaper força status=abandoned após 7d de inatividade".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory state mirroring the pattern used by other procedure spec files.
// Tuplas (tenant_id, agent_id) que o dispatcher enumera (DISTINCT in_progress).
const inProgressTuples: Array<{ tenant_id: string; agent_id: string }> = [];
// Keyed por execution.id. listStaleInProgress filtra por (tenant_id, agent_id)
// do contexto ATUAL + status/ttl — espelha a query real (agora agent-scoped).
const executionsState: Record<string, any> = {};
const eventsLog: any[] = [];
// Contextos REAIS abertos pelo worker (capturados em listStaleInProgress).
const contextsSeen: Array<{ tenant_id: string; agent_id: string }> = [];

// db.selectDistinct → enumeração de tuplas; withTx → passthrough.
vi.mock('@/db/client.js', () => ({
  db: {
    selectDistinct: () => ({
      from: () => ({
        where: async () => inProgressTuples.slice(),
      }),
    }),
  },
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    procedureExecutionsRepo: {
      listStaleInProgress: vi.fn(async (opts: { ttl_days: number; limit?: number }) => {
        // Issue #323: a query real agora filtra por tenant_id E agent_id.
        // O mock espelha isso para garantir que cada iteração só veja as
        // execuções stale do (tenant, agent) corrente.
        const { getCurrentTenant, getCurrentAgent } = await import(
          '@/db/tenant-context.js'
        );
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        contextsSeen.push({ tenant_id, agent_id });
        const cutoff = Date.now() - opts.ttl_days * 86_400_000;
        const all = Object.values(executionsState).filter((ex: any) => {
          if (ex.tenant_id !== tenant_id) return false;
          if (ex.agent_id !== agent_id) return false;
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
      // Tx-variant used by the post-fix reaper. Capture the ALS agent_id so we
      // can assert the audit event lands under the REAL agent (#323), not
      // 'default'.
      recordTx: vi.fn(async (_tx: unknown, input: any) => {
        const { getCurrentTenant, getCurrentAgent } = await import(
          '@/db/tenant-context.js'
        );
        eventsLog.push({
          ...input,
          ctx_tenant_id: getCurrentTenant(),
          ctx_agent_id: getCurrentAgent(),
          created_at: new Date(),
        });
      }),
    },
  };
});

import { runProcedureExecutionReaper } from '@/workers/procedure-execution-reaper.js';

function seedExecution(overrides: Partial<any> & { id: string; tenant_id: string }) {
  const row = {
    agent_id: 'agent-1',
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
  // Register the (tenant, agent) tuple for dispatcher enumeration (DISTINCT).
  if (row.status === 'in_progress') {
    const exists = inProgressTuples.some(
      (t) => t.tenant_id === row.tenant_id && t.agent_id === row.agent_id,
    );
    if (!exists) {
      inProgressTuples.push({ tenant_id: row.tenant_id, agent_id: row.agent_id });
    }
  }
  return row;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

describe('runProcedureExecutionReaper', () => {
  beforeEach(() => {
    inProgressTuples.length = 0;
    contextsSeen.length = 0;
    for (const k of Object.keys(executionsState)) delete executionsState[k];
    eventsLog.length = 0;
    vi.clearAllMocks();
    delete process.env.PROCEDURE_TTL_DAYS;
  });

  it('cenário 1: 1 stale in_progress execution → appends auto_abandoned event AND sets status=abandoned/no_response', async () => {
    seedExecution({
      id: 'exec-stale',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
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
    // #323: event carimbado sob o agent REAL, nunca 'default'.
    expect(eventsLog[0].ctx_tenant_id).toBe('tenant-a');
    expect(eventsLog[0].ctx_agent_id).toBe('agent-1');

    // Execution updated to abandoned/no_response with ended_at set.
    const updated = executionsState['exec-stale'];
    expect(updated.status).toBe('abandoned');
    expect(updated.outcome).toBe('no_response');
    expect(updated.ended_at).toBeInstanceOf(Date);

    // contexto aberto = (tenant-a, agent-1), nunca 'default'.
    expect(contextsSeen).toEqual([{ tenant_id: 'tenant-a', agent_id: 'agent-1' }]);
  });

  it('cenário 2: fresh execution (last_activity_at recente) → reaper NÃO toca', async () => {
    seedExecution({
      id: 'exec-fresh',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      status: 'in_progress',
      last_activity_at: daysAgo(1), // 1 day old — well under 7d TTL
    });

    await runProcedureExecutionReaper();

    expect(eventsLog).toHaveLength(0);
    expect(executionsState['exec-fresh'].status).toBe('in_progress');
    expect(executionsState['exec-fresh'].outcome).toBeNull();
    expect(executionsState['exec-fresh'].ended_at).toBeNull();
  });

  it('cenário 3: execução já completed/aborted → reaper ignora (não enumera + listStaleInProgress filtra por in_progress)', async () => {
    seedExecution({
      id: 'exec-completed',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      status: 'completed',
      outcome: 'success',
      last_activity_at: daysAgo(30), // ancient — but status=completed
      ended_at: daysAgo(30),
    });
    seedExecution({
      id: 'exec-aborted',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
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

  it('cenário 4: múltiplas tuplas (tenants distintos) → reaper itera todas e isola por (tenant, agent)', async () => {
    seedExecution({
      id: 'exec-a-stale',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      status: 'in_progress',
      last_activity_at: daysAgo(10),
    });
    seedExecution({
      id: 'exec-b-stale',
      tenant_id: 'tenant-b',
      agent_id: 'agent-9',
      status: 'in_progress',
      last_activity_at: daysAgo(9),
    });
    seedExecution({
      id: 'exec-b-fresh',
      tenant_id: 'tenant-b',
      agent_id: 'agent-9',
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

  it('cenário 5 (regressão #323): DOIS agents no MESMO tenant → AMBOS reapados, cada event sob o seu agent', async () => {
    // Antes do fix: o worker abria {tenant, agent:'default'}; listStaleInProgress
    // filtrava só por tenant, então varria os DOIS agents numa passada, mas
    // gravava ambos os events com agent_id='default' (mis-attribution).
    // Agora cada agent ganha sua própria iteração e o event fica correto.
    seedExecution({
      id: 'exec-agent1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      status: 'in_progress',
      last_activity_at: daysAgo(10),
      current_step_id: 'step-1',
    });
    seedExecution({
      id: 'exec-agent2',
      tenant_id: 'tenant-a',
      agent_id: 'agent-2',
      status: 'in_progress',
      last_activity_at: daysAgo(11),
      current_step_id: 'step-2',
    });

    await runProcedureExecutionReaper();

    // Ambos reapados.
    expect(eventsLog).toHaveLength(2);
    const byExec = Object.fromEntries(eventsLog.map((e) => [e.execution_id, e]));
    expect(executionsState['exec-agent1'].status).toBe('abandoned');
    expect(executionsState['exec-agent2'].status).toBe('abandoned');

    // Cada event carimbado sob o agent REAL correspondente — não 'default'.
    expect(byExec['exec-agent1'].ctx_agent_id).toBe('agent-1');
    expect(byExec['exec-agent2'].ctx_agent_id).toBe('agent-2');
    expect(eventsLog.some((e) => e.ctx_agent_id === 'default')).toBe(false);

    // Ambos contextos REAIS abertos (um por agent).
    expect(contextsSeen).toEqual([
      { tenant_id: 'tenant-a', agent_id: 'agent-1' },
      { tenant_id: 'tenant-a', agent_id: 'agent-2' },
    ]);
  });

  it('cenário 6: TTL customizado via PROCEDURE_TTL_DAYS=14 → exec de 8d NÃO é reaped', async () => {
    // Set env BEFORE module evaluates the constant. The worker reads
    // process.env.PROCEDURE_TTL_DAYS at module load time, so we have to
    // re-import via resetModules to pick up the new value.
    process.env.PROCEDURE_TTL_DAYS = '14';
    vi.resetModules();
    const mod = await import('@/workers/procedure-execution-reaper.js');

    seedExecution({
      id: 'exec-8d',
      tenant_id: 'tenant-a',
      agent_id: 'agent-1',
      status: 'in_progress',
      last_activity_at: daysAgo(8),
    });

    await mod.runProcedureExecutionReaper();

    expect(eventsLog).toHaveLength(0);
    expect(executionsState['exec-8d'].status).toBe('in_progress');
  });
});
