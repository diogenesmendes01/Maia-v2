import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// PR #84 wraps engine.startExecution/advance/complete/abort in withTx and
// routes their event+state writes through recordTx/updateStateTx. Mock the
// transaction wrapper as identity — repo mocks already use shared in-memory
// state regardless of `tx` argument.
vi.mock('@/db/client.js', () => ({
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  db: {},
}));

// In-memory state, mirroring the pattern used by p3b-procedure-runtime.spec.ts
// so the runner can drive engine/repo calls without a real DB.
const execState: Record<string, any> = {};
const events: any[] = [];

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionsRepo: {
      create: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = {
          id,
          ...input,
          status: input.status ?? 'in_progress',
          completed_steps: input.completed_steps ?? [],
          execution_state: input.execution_state ?? {},
        };
        return execState[id];
      }),
      // PR #84 introduced createOrFindActive returning { execution, created }.
      createOrFindActive: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = {
          id,
          ...input,
          status: input.status ?? 'in_progress',
          completed_steps: input.completed_steps ?? [],
          execution_state: input.execution_state ?? {},
        };
        return { execution: execState[id], created: true };
      }),
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      findActiveForConversa: vi.fn(async () => null),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
      // PR #84 added updateStateTx — engine writes go through this inside withTx.
      updateStateTx: vi.fn(async (_tx: unknown, id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => {
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      // PR #84 added recordTx — engine writes go through this inside withTx.
      recordTx: vi.fn(async (_tx: unknown, input: any) => {
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      listByExecution: vi.fn(async (execution_id: string) =>
        events.filter((e) => e.execution_id === execution_id),
      ),
    },
  };
});

import { runProcedureTest } from '@/procedures/test-runner.js';
import type { ProcedureDefinition } from '@/db/schema.js';

function makeDefinition(overrides: Partial<ProcedureDefinition> = {}): ProcedureDefinition {
  return {
    id: 'def-1',
    tenant_id: 'sandbox-test',
    agent_id: 'sandbox',
    scope: 'tenant',
    owner_agent_id: null,
    nome: 'qualify-lead',
    version_number: 1,
    status: 'proposed',
    intencao: 'Qualificar lead',
    when_apply: {} as any,
    when_not_apply: {} as any,
    steps: [
      { id: 'step-1', intencao: 'Saudar', como: 'oi', sucesso_criteria_ref: 'crit-1' },
      { id: 'step-2', intencao: 'Encerrar', como: 'tchau', depends_on: ['step-1'], sucesso_criteria_ref: 'crit-2' },
    ] as any,
    success_criteria: [
      { id: 'crit-1', type: 'machine_check', expression: 'ola' },
      { id: 'crit-2', type: 'machine_check', expression: 'adeus' },
    ] as any,
    failure_modes: [] as any,
    tools_referenced: [] as any,
    source: 'manual',
    proposed_by: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    deactivated_at: null,
    source_candidate_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as ProcedureDefinition;
}

describe('runProcedureTest', () => {
  beforeEach(() => {
    for (const k of Object.keys(execState)) delete execState[k];
    events.length = 0;
    vi.clearAllMocks();
  });

  it('happy path: scenario walks both steps until success → status=pass', async () => {
    const definition = makeDefinition();

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runProcedureTest({
        test_id: 't-happy',
        definition,
        scenario: {
          turns: [
            { role: 'user', message: 'cliente chegou' },
            { role: 'agent', response_text: 'ola, bem-vindo!' },
            { role: 'agent', response_text: 'foi um prazer, adeus!' },
          ],
        },
        expected_outcome: 'success',
        expected_step_path: ['step-1', 'step-2'],
      });

      expect(result.status).toBe('pass');
      expect(result.details.actual_outcome).toBe('success');
      expect(result.details.actual_step_path).toEqual(['step-1', 'step-2']);
      expect(result.details.diff).toEqual([]);
    });
  });

  it('wrong outcome: scenario stops mid-procedure but expected=success → status=fail', async () => {
    const definition = makeDefinition();

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runProcedureTest({
        test_id: 't-fail',
        definition,
        scenario: {
          turns: [
            { role: 'user', message: 'oi' },
            { role: 'agent', response_text: 'ola!' },
            // No second agent turn → step-2 never evaluated.
          ],
        },
        expected_outcome: 'success',
      });

      expect(result.status).toBe('fail');
      expect(result.details.expected_outcome).toBe('success');
      expect(result.details.actual_outcome).toBe('partial');
      expect(result.details.diff.length).toBeGreaterThan(0);
      expect(result.details.diff.some((d) => d.includes('outcome'))).toBe(true);
    });
  });

  it('human confirmation injection: approval at right step → status=pass', async () => {
    const definition = makeDefinition({
      steps: [
        { id: 'step-1', intencao: 'Saudar', como: 'oi', sucesso_criteria_ref: 'crit-1' },
        { id: 'step-h', intencao: 'Confirmar humano', como: '...', depends_on: ['step-1'], sucesso_criteria_ref: 'crit-h' },
      ] as any,
      success_criteria: [
        { id: 'crit-1', type: 'machine_check', expression: 'ola' },
        { id: 'crit-h', type: 'human_confirmed' },
      ] as any,
    });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runProcedureTest({
        test_id: 't-human',
        definition,
        scenario: {
          turns: [
            { role: 'user', message: 'oi' },
            { role: 'agent', response_text: 'ola!' }, // completes step-1, lands on step-h
            { role: 'agent', response_text: 'aguardando aprovacao...' }, // step-h re-evaluates after confirmation injects
          ],
          human_confirmations: [
            { at_step: 'step-h', decision: 'approved', operator_id: 'op-1' },
          ],
        },
        expected_outcome: 'success',
        expected_step_path: ['step-1', 'step-h'],
      });

      expect(result.status).toBe('pass');
      expect(result.details.actual_outcome).toBe('success');
      expect(result.details.actual_step_path).toEqual(['step-1', 'step-h']);
    });
  });

  it('error path: engine throws → status=error, details.error populated', async () => {
    const definition = makeDefinition();

    // Force startExecution to throw by sabotaging the events repo.
    // PR #84: engine.startExecution writes events via recordTx now.
    const repos = await import('@/db/repositories.js');
    const originalRecord = repos.procedureExecutionEventsRepo.record;
    const originalRecordTx = (repos.procedureExecutionEventsRepo as any).recordTx;
    (repos.procedureExecutionEventsRepo.record as any) = vi.fn(async () => {
      throw new Error('boom-from-events-repo');
    });
    (repos.procedureExecutionEventsRepo as any).recordTx = vi.fn(async () => {
      throw new Error('boom-from-events-repo');
    });

    try {
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const result = await runProcedureTest({
          test_id: 't-error',
          definition,
          scenario: {
            turns: [
              { role: 'user', message: 'oi' },
              { role: 'agent', response_text: 'ola!' },
            ],
          },
          expected_outcome: 'success',
        });

        expect(result.status).toBe('error');
        expect(result.details.error).toBeDefined();
        expect(result.details.error).toContain('boom-from-events-repo');
      });
    } finally {
      (repos.procedureExecutionEventsRepo.record as any) = originalRecord;
      (repos.procedureExecutionEventsRepo as any).recordTx = originalRecordTx;
    }
  });
});
