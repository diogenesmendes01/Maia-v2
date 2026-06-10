/**
 * Issue #469 — registry de kinds do work loop (v1).
 */
import { describe, it, expect } from 'vitest';
import {
  OBJECTIVE_KINDS,
  OBJECTIVE_KIND_IDS,
  getObjectiveKind,
} from '@/objectives/kinds.js';
import type { AgentObjective, ObjectiveTask } from '@/db/schema.js';

const objective = {
  id: 'obj-1',
  tenant_id: 'tenant-A',
  agent_id: 'agent-a',
  kind: 'manual',
  title: 'Validar ciclo',
  params: {},
  status: 'active',
  created_by: 'user-1',
  created_at: new Date(),
  updated_at: new Date(),
} as AgentObjective;

function task(payload: Record<string, unknown>): ObjectiveTask {
  return {
    id: 'task-1',
    objective_id: 'obj-1',
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    natural_key: 'manual:x',
    title: 't',
    payload,
    status: 'running',
    procedure_execution_id: null,
    pending_question_id: null,
    outcome: null,
    error_detail: null,
    created_at: new Date(),
    completed_at: null,
  } as ObjectiveTask;
}

describe('OBJECTIVE_KINDS', () => {
  it('v1 expõe exatamente o kind manual', () => {
    expect(OBJECTIVE_KIND_IDS).toEqual(['manual']);
    expect(getObjectiveKind('manual')).toBe(OBJECTIVE_KINDS.manual);
    expect(getObjectiveKind('inadimplencia')).toBeNull();
  });

  it('manual: flow auto (default) conclui com outcome', async () => {
    const r = await OBJECTIVE_KINDS.manual!.execute({ objective, task: task({}) });
    expect(r.transition).toBe('done');
    if (r.transition === 'done') {
      expect(r.outcome.kind).toBe('manual');
    }
  });

  it('manual: flow exception vai para a fila de exceções', async () => {
    const r = await OBJECTIVE_KINDS.manual!.execute({
      objective,
      task: task({ flow: 'exception' }),
    });
    expect(r.transition).toBe('waiting_human');
  });
});
