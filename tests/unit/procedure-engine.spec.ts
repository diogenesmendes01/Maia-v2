import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const execState: Record<string, any> = {};
const events: any[] = [];

vi.mock('@/db/client.js', async () => {
  // withTx(fn): pass a fake `tx` that the repo mocks treat as `db`.
  // The test mocks bypass real SQL anyway — the goal is just to thread
  // the tx argument through without crashing.
  return {
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    db: {},
    pool: {},
    isDbConnected: () => true,
    probeDb: async () => true,
    shutdownDb: async () => {},
  };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionsRepo: {
      create: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = { id, ...input, status: 'in_progress', completed_steps: [] };
        return execState[id];
      }),
      createOrFindActive: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = { id, ...input, status: 'in_progress', completed_steps: [] };
        return { execution: execState[id], created: true };
      }),
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
      updateStateTx: vi.fn(async (_tx: unknown, id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
      findActiveForConversa: vi.fn(async () => null),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => { events.push(input); }),
      recordTx: vi.fn(async (_tx: unknown, input: any) => { events.push(input); }),
      listByExecution: vi.fn(async (execution_id: string) => events.filter((e) => e.execution_id === execution_id)),
    },
  };
});

import {
  startExecution,
  advanceStep,
  completeExecution,
  abortExecution,
  replayState,
  recordCriterionChecked,
  recordToolCalled,
} from '@/procedures/engine.js';

describe('procedure engine', () => {
  beforeEach(() => {
    for (const k of Object.keys(execState)) delete execState[k];
    events.length = 0;
    vi.clearAllMocks();
  });

  it('startExecution cria execution + emite execution_started event', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution, created } = await startExecution({
        definition_id: 'def-1',
        definition_version: 1,
        conversa_id: 'conv-1',
        first_step_id: 'step-1',
      });
      expect(execution.status).toBe('in_progress');
      expect(created).toBe(true);
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('execution_started');
      // Mocked exec_id is auto-injected, but the events log should attach
      // to the new execution.
      expect(events[0].execution_id).toBe(execution.id);
    });
  });

  it('advanceStep registra event + atualiza state', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await advanceStep({ execution_id: exec.id, next_step_id: 'step-2', completed_step_id: 'step-1' });

      expect(events.some((e) => e.event_type === 'step_completed')).toBe(true);
      // P84-C4: state_updated event is emitted on every state mutation.
      expect(events.some((e) => e.event_type === 'state_updated')).toBe(true);
      expect(execState[exec.id].current_step_id).toBe('step-2');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('completeExecution finaliza com outcome + emite state_updated', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await completeExecution({ execution_id: exec.id, outcome: 'success' });
      expect(execState[exec.id].status).toBe('completed');
      expect(execState[exec.id].outcome).toBe('success');
      expect(events.some((e) => e.event_type === 'execution_completed')).toBe(true);
      expect(events.some((e) => e.event_type === 'state_updated')).toBe(true);
    });
  });

  it('abortExecution registra com reason + state_updated', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await abortExecution({ execution_id: exec.id, reason: 'user_request' });
      expect(execState[exec.id].status).toBe('aborted');
      expect(events.some((e) => e.event_type === 'execution_aborted')).toBe(true);
      expect(events.some((e) => e.event_type === 'state_updated' && e.payload.status === 'aborted')).toBe(true);
    });
  });

  it('replayState reconstroi state inclusive outcome/notes a partir de state_updated', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await advanceStep({ execution_id: exec.id, next_step_id: 'step-2', completed_step_id: 'step-1' });
      const state = await replayState(exec.id);
      expect(state.completed_steps).toContain('step-1');
      expect(state.current_step_id).toBe('step-2');
      expect(state.status).toBe('in_progress');
      expect(state.outcome).toBeNull();
    });
  });

  it('P84-C4: recordCriterionChecked emite criterion_checked event', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      events.length = 0; // drop the execution_started event
      await recordCriterionChecked({
        execution_id: exec.id,
        step_id: 'step-1',
        criterion_id: 'crit-1',
        criterion_type: 'machine_check',
        passed: true,
        evidence: 'regex match',
      });
      const e = events.find((x) => x.event_type === 'criterion_checked');
      expect(e).toBeDefined();
      expect(e.payload.passed).toBe(true);
      expect(e.payload.criterion_id).toBe('crit-1');
    });
  });

  it('P84-C4: recordToolCalled emite tool_called event com truncation', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      events.length = 0;
      const big = 'x'.repeat(5000);
      await recordToolCalled({
        execution_id: exec.id,
        step_id: 'step-1',
        tool_name: 'register-transaction',
        result: big,
      });
      const e = events.find((x) => x.event_type === 'tool_called');
      expect(e).toBeDefined();
      expect(e.payload.tool_name).toBe('register-transaction');
      // Truncation kicks in for results > 4096 chars.
      expect(typeof e.payload.result === 'object' && '_truncated' in e.payload.result).toBe(true);
    });
  });
});
