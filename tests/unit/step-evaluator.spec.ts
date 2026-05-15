import { describe, it, expect } from 'vitest';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';

describe('evaluateCurrentStep', () => {
  it('machine_check passa → step_completed=true', () => {
    const result = evaluateCurrentStep({
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

  it('machine_check falha → step_completed=false', () => {
    const result = evaluateCurrentStep({
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

  it('tool_result passa quando tool foi chamada com expected', () => {
    const result = evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'tool_result', tool: 'register-transaction', expected: 'confirmed' }],
      } as any,
      response_context: { tools_called: [{ name: 'register-transaction', result: { status: 'confirmed' } }] },
    });
    expect(result.step_completed).toBe(true);
  });

  it('último step completed → next_step_id=null (procedure done)', () => {
    const result = evaluateCurrentStep({
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

  it('llm_judge/user_signal/human_confirmed: skip em P3b (tratados como failed para forçar próximo turno)', () => {
    const result = evaluateCurrentStep({
      execution: { id: 'e1', definition_id: 'd1', current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'llm_judge', prompt: 'X?', threshold: 0.7 }],
      } as any,
      response_context: { response_text: 'algo' },
    });
    // P3b doesn't evaluate llm_judge — returns step_completed=false (waits for P3c)
    expect(result.step_completed).toBe(false);
    // P84-C3: surfaces as unsupported_criterion_only so the audit trail
    // can see the stall instead of silently looping.
    expect(result.stall_reason).toBe('unsupported_criterion_only');
  });

  it('P84-C3: zero-criteria step → stall_reason=no_criteria_defined, não avança', () => {
    const result = evaluateCurrentStep({
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

  it('P84-C3: DAG com 2 branches paralelos → next_step deterministico + alternates reportados', () => {
    const result = evaluateCurrentStep({
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

  it('P84-C3: criterion deletado/missing ref → stepCriteria=[] → stall, não passa', () => {
    const result = evaluateCurrentStep({
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
