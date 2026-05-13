import { describe, it, expect, vi } from 'vitest';

// P3c Task 6: o ramo `human_confirmed` agora consulta
// procedureExecutionEventsRepo.listByExecution. Como estes testes não exercitam
// confirmação humana de fato (cobertos em step-evaluator-human-confirmed.spec),
// retornamos lista vazia → comportamento "awaiting".
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionEventsRepo: {
      record: vi.fn(async () => {}),
      listByExecution: vi.fn(async () => []),
    },
  };
});

import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';

describe('evaluateCurrentStep', () => {
  it('machine_check passa → step_completed=true', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }, { id: 'step-2', depends_on: ['step-1'] }],
        success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'cnpj' }],
      } as any,
      response_context: { response_text: 'O cnpj da empresa foi confirmado' },
    });
    expect(result.step_completed).toBe(true);
    expect(result.next_step_id).toBe('step-2');
    expect(result.stall_reason).toBeNull();
    expect(result.branch_alternates).toEqual([]);
  });

  it('machine_check falha → step_completed=false', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'cnpj' }],
      } as any,
      response_context: { response_text: 'preciso de mais info' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.next_step_id).toBeNull();
  });

  it('tool_result passa quando tool foi chamada com expected', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'tool_result', tool: 'register-transaction', expected: 'confirmed' }],
      } as any,
      response_context: { tools_called: [{ name: 'register-transaction', result: { status: 'confirmed' } }] },
    });
    expect(result.step_completed).toBe(true);
  });

  it('último step completed → next_step_id=null (procedure done)', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'final-step', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'final-step', sucesso_criteria_ref: 'crit-final' }],
        success_criteria: [{ id: 'crit-final', type: 'machine_check', expression: 'done' }],
      } as any,
      response_context: { response_text: 'tudo done' },
    });
    expect(result.step_completed).toBe(true);
    expect(result.next_step_id).toBeNull();
  });

  it('user_signal (agreement) com user_message positivo → step_completed=true', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'user_signal', signal: 'agreement' }],
      } as any,
      response_context: { user_message: 'sim, pode ser' },
    });
    expect(result.step_completed).toBe(true);
    expect(result.criterion_results[0]?.evidence).toContain('user_signal positive');
  });

  it('user_signal (agreement) com user_message negativo → step_completed=false', async () => {
    const result = await evaluateCurrentStep({
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'user_signal', signal: 'agreement' }],
      } as any,
      response_context: { user_message: 'não quero' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toContain('user_signal negative');
  });

  it('human_confirmed sem evento → step_completed=false, evidence "awaiting"', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'exec-x', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'human_confirmed' }],
      } as any,
      response_context: { response_text: 'algo' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toMatch(/awaiting/i);
  });

  it('P84-C3: zero-criteria step → stall_reason=no_criteria_defined, não avança', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1' /* no sucesso_criteria_ref */ }, { id: 'step-2', depends_on: ['step-1'] }],
        success_criteria: [],
      } as any,
      response_context: { response_text: 'qualquer coisa' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.stall_reason).toBe('no_criteria_defined');
    expect(result.next_step_id).toBeNull();
  });

  it('P84-C3: DAG com 2 branches paralelos → next_step deterministico + alternates reportados', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [
          { id: 'step-1', sucesso_criteria_ref: 'crit-1' },
          // Both 2a and 2b depend on step-1 → after step-1 completes,
          // both are eligible. Deterministic picker takes the first in
          // array order, reports the second as an alternate.
          { id: 'step-2a', depends_on: ['step-1'] },
          { id: 'step-2b', depends_on: ['step-1'] },
        ],
        success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'ok' }],
      } as any,
      response_context: { response_text: 'tudo ok!' },
    });
    expect(result.step_completed).toBe(true);
    expect(result.next_step_id).toBe('step-2a');
    expect(result.branch_alternates).toEqual(['step-2b']);
  });

  it('P84-C3: criterion deletado/missing ref → stepCriteria=[] → stall, não passa', async () => {
    const result = await evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        // sucesso_criteria_ref aponta para criterion que não existe.
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-DELETED' }],
        success_criteria: [{ id: 'crit-other', type: 'machine_check', expression: 'x' }],
      } as any,
      response_context: { response_text: 'whatever' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.stall_reason).toBe('no_criteria_defined');
  });
});
