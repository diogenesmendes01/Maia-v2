import { describe, it, expect } from 'vitest';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';

describe('evaluateCurrentStep', () => {
  it('machine_check passa → step_completed=true', async () => {
    const result = await evaluateCurrentStep({
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }, { id: 'step-2', depends_on: ['step-1'] }],
        success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'cnpj' }],
      } as any,
      response_context: { response_text: 'O cnpj da empresa foi confirmado' },
    });
    expect(result.step_completed).toBe(true);
    expect(result.next_step_id).toBe('step-2');
  });

  it('machine_check falha → step_completed=false', async () => {
    const result = await evaluateCurrentStep({
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
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
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
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
      execution: { current_step_id: 'final-step', completed_steps: [] } as any,
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
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
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

  it('human_confirmed: ainda não avaliado (Task 6)', async () => {
    const result = await evaluateCurrentStep({
      execution: { current_step_id: 'step-1', completed_steps: [] } as any,
      definition: {
        steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
        success_criteria: [{ id: 'crit-1', type: 'human_confirmed' }],
      } as any,
      response_context: { response_text: 'algo' },
    });
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toContain('Task 6');
  });
});
