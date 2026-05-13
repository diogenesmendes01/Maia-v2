import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const events: any[] = [];

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionsRepo: {
      create: vi.fn(),
      findById: vi.fn(),
      updateState: vi.fn(),
      findActiveForConversa: vi.fn(),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => {
        // Mirror the real repo: created_at is server-set; tests inject a Date.
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      listByExecution: vi.fn(async (execution_id: string) =>
        events.filter((e) => e.execution_id === execution_id),
      ),
    },
  };
});

import {
  recordHumanConfirmation,
  getLatestHumanConfirmation,
} from '@/procedures/engine.js';

describe('procedure engine — human confirmation', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
  });

  it('recordHumanConfirmation grava evento human_confirmation com payload correto', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      await recordHumanConfirmation({
        execution_id: 'exec-1',
        step_id: 'step-a',
        operator_id: 'op-42',
        decision: 'approved',
        notes: 'looks good',
      });
      expect(events.length).toBe(1);
      const ev = events[0];
      expect(ev.execution_id).toBe('exec-1');
      expect(ev.event_type).toBe('human_confirmation');
      expect(ev.payload).toMatchObject({
        step_id: 'step-a',
        operator_id: 'op-42',
        decision: 'approved',
        notes: 'looks good',
      });
    });
  });

  it('getLatestHumanConfirmation ignora eventos de outros step_ids e retorna o último do step alvo', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      // Event for OTHER step (must be ignored)
      events.push({
        execution_id: 'exec-1',
        event_type: 'human_confirmation',
        payload: { step_id: 'step-OTHER', operator_id: 'op-x', decision: 'approved' },
        created_at: new Date(Date.now() - 60_000),
      });
      // Older approval for target step
      events.push({
        execution_id: 'exec-1',
        event_type: 'human_confirmation',
        payload: { step_id: 'step-a', operator_id: 'op-1', decision: 'approved' },
        created_at: new Date(Date.now() - 30_000),
      });
      // Newest rejection for target step → must win
      events.push({
        execution_id: 'exec-1',
        event_type: 'human_confirmation',
        payload: { step_id: 'step-a', operator_id: 'op-2', decision: 'rejected' },
        created_at: new Date(),
      });

      const got = await getLatestHumanConfirmation({ execution_id: 'exec-1', step_id: 'step-a' });
      expect(got).not.toBeNull();
      expect(got?.decision).toBe('rejected');
      expect(got?.operator_id).toBe('op-2');
    });
  });

  it('getLatestHumanConfirmation retorna null quando não há eventos para o step', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const got = await getLatestHumanConfirmation({ execution_id: 'exec-1', step_id: 'step-a' });
      expect(got).toBeNull();
    });
  });
});
