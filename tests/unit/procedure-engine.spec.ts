import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const execState: Record<string, any> = {};
const events: any[] = [];

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
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
      findActiveForConversa: vi.fn(async () => null),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => { events.push(input); }),
      listByExecution: vi.fn(async (execution_id: string) => events.filter((e) => e.execution_id === execution_id)),
    },
  };
});

import { startExecution, advanceStep, completeExecution, abortExecution, replayState } from '@/procedures/engine.js';

describe('procedure engine', () => {
  beforeEach(() => {
    for (const k of Object.keys(execState)) delete execState[k];
    events.length = 0;
    vi.clearAllMocks();
  });

  it('startExecution cria execution + emite execution_started event', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await startExecution({
        definition_id: 'def-1',
        definition_version: 1,
        conversa_id: 'conv-1',
        first_step_id: 'step-1',
      });
      expect(exec.status).toBe('in_progress');
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('execution_started');
    });
  });

  it('advanceStep registra event + atualiza state', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await advanceStep({ execution_id: exec.id, next_step_id: 'step-2', completed_step_id: 'step-1' });

      expect(events.some((e) => e.event_type === 'step_completed')).toBe(true);
      expect(execState[exec.id].current_step_id).toBe('step-2');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('completeExecution finaliza com outcome', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await completeExecution({ execution_id: exec.id, outcome: 'success' });
      expect(execState[exec.id].status).toBe('completed');
      expect(execState[exec.id].outcome).toBe('success');
    });
  });

  it('abortExecution registra com reason', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await abortExecution({ execution_id: exec.id, reason: 'user_request' });
      expect(execState[exec.id].status).toBe('aborted');
    });
  });

  it('replayState reconstruct from events', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await startExecution({ definition_id: 'def-1', definition_version: 1, conversa_id: 'c1', first_step_id: 'step-1' });
      await advanceStep({ execution_id: exec.id, next_step_id: 'step-2', completed_step_id: 'step-1' });
      const state = await replayState(exec.id);
      expect(state.completed_steps).toContain('step-1');
      expect(state.current_step_id).toBe('step-2');
      expect(state.status).toBe('in_progress');
    });
  });
});
