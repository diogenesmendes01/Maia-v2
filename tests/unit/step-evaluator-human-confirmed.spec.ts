import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      listByExecution: vi.fn(async (execution_id: string) =>
        events.filter((e) => e.execution_id === execution_id),
      ),
    },
  };
});

import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';

function makeArgs(criterion: Record<string, unknown>): Parameters<typeof evaluateCurrentStep>[0] {
  return {
    execution: { id: 'exec-1', current_step_id: 'step-1', completed_steps: [] } as any,
    definition: {
      steps: [{ id: 'step-1', sucesso_criteria_ref: 'crit-1' }],
      success_criteria: [{ id: 'crit-1', type: 'human_confirmed', ...criterion }],
    } as any,
    response_context: { response_text: 'irrelevante' },
  };
}

describe('evaluateCurrentStep — human_confirmed', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
  });

  it('sem evento → passed=false, evidence menciona "awaiting"', async () => {
    const result = await evaluateCurrentStep(makeArgs({}));
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.passed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toMatch(/awaiting/i);
  });

  it('approved → passed=true, evidence menciona operator_id', async () => {
    events.push({
      execution_id: 'exec-1',
      event_type: 'human_confirmation',
      payload: { step_id: 'step-1', operator_id: 'op-42', decision: 'approved' },
      created_at: new Date(),
    });
    const result = await evaluateCurrentStep(makeArgs({}));
    expect(result.step_completed).toBe(true);
    expect(result.criterion_results[0]?.passed).toBe(true);
    expect(result.criterion_results[0]?.evidence).toMatch(/approved/i);
    expect(result.criterion_results[0]?.evidence).toContain('op-42');
  });

  it('rejected → passed=false, evidence menciona "rejected" + operator_id', async () => {
    events.push({
      execution_id: 'exec-1',
      event_type: 'human_confirmation',
      payload: { step_id: 'step-1', operator_id: 'op-99', decision: 'rejected' },
      created_at: new Date(),
    });
    const result = await evaluateCurrentStep(makeArgs({}));
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.passed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toMatch(/rejected/i);
    expect(result.criterion_results[0]?.evidence).toContain('op-99');
  });

  it('approved porém ttl expirou → passed=false, evidence menciona "expired"', async () => {
    // ttl_minutes=5, evento criado há 10 minutos → expirado
    events.push({
      execution_id: 'exec-1',
      event_type: 'human_confirmation',
      payload: { step_id: 'step-1', operator_id: 'op-1', decision: 'approved' },
      created_at: new Date(Date.now() - 10 * 60_000),
    });
    const result = await evaluateCurrentStep(makeArgs({ ttl_minutes: 5 }));
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.passed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toMatch(/expired/i);
  });

  it('múltiplos eventos para mesmo step → LATEST vence (approved depois rejected = rejected)', async () => {
    events.push({
      execution_id: 'exec-1',
      event_type: 'human_confirmation',
      payload: { step_id: 'step-1', operator_id: 'op-1', decision: 'approved' },
      created_at: new Date(Date.now() - 60_000),
    });
    events.push({
      execution_id: 'exec-1',
      event_type: 'human_confirmation',
      payload: { step_id: 'step-1', operator_id: 'op-2', decision: 'rejected' },
      created_at: new Date(),
    });
    const result = await evaluateCurrentStep(makeArgs({}));
    expect(result.step_completed).toBe(false);
    expect(result.criterion_results[0]?.evidence).toMatch(/rejected/i);
    expect(result.criterion_results[0]?.evidence).toContain('op-2');
  });
});
