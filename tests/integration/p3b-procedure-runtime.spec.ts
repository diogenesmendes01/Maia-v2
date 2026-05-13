import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { selectProcedure } from '@/cognition/procedure-selector.js';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';
import * as engine from '@/procedures/engine.js';

// In-memory state
const execState: Record<string, any> = {};
const events: any[] = [];
const decisions: any[] = [];
const definitions: Record<string, any> = {};
const assignments: any[] = [];

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionsRepo: {
      create: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = { id, ...input, status: 'in_progress', completed_steps: input.completed_steps ?? [] };
        return execState[id];
      }),
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      findActiveForConversa: vi.fn(async (conversa_id: string) => {
        return Object.values(execState).find((e: any) => e.conversa_id === conversa_id && e.status === 'in_progress') ?? null;
      }),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => { events.push(input); }),
      listByExecution: vi.fn(async (id: string) => events.filter((e) => e.execution_id === id)),
    },
    procedureSelectorDecisionsRepo: {
      record: vi.fn(async (input: any) => { decisions.push(input); }),
      recentByConversa: vi.fn(async () => decisions),
    },
    procedureDefinitionsRepo: {
      findById: vi.fn(async (id: string) => definitions[id] ?? null),
      findActiveByName: vi.fn(async () => null),
      listByStatus: vi.fn(async () => []),
      listAllVersionsByName: vi.fn(async () => []),
      create: vi.fn(),
      updateStatus: vi.fn(),
    },
    procedureAssignmentsRepo: {
      listForTarget: vi.fn(async () => assignments),
      create: vi.fn(),
      disable: vi.fn(),
    },
    cognitiveModuleLogRepo: { record: vi.fn(async () => {}), recentByModule: vi.fn(async () => []) },
  };
});

import { callLLM } from '@/lib/claude.js';

describe('P3b procedure runtime integration', () => {
  beforeEach(() => {
    for (const k of Object.keys(execState)) delete execState[k];
    for (const k of Object.keys(definitions)) delete definitions[k];
    events.length = 0;
    decisions.length = 0;
    assignments.length = 0;
    vi.clearAllMocks();
  });

  it('cenário 1: sem procedures assigned → selector decision=none', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await selectProcedure({
        conversa_id: 'c1',
        current_message: 'oi tudo bem?',
        current_execution: null,
      });
      expect(result.decision).toBe('none');
    });
  });

  it('cenário 2: procedure assigned + match → selector decision=start → execution criada', async () => {
    const defId = 'def-qualify';
    definitions[defId] = {
      id: defId,
      nome: 'qualify-lead',
      version_number: 1,
      status: 'active',
      intencao: 'Qualificar lead',
      when_apply: { tags: ['lead_new'] },
      steps: [{ id: 'step-1', intencao: 'Descobrir motivo', como: 'Pergunte aberto' }],
      success_criteria: [],
    };
    assignments.push({ id: 'a1', definition_id: defId, definition_version: 1, target_type: 'agent', target_id: 'default', enabled: true });

    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ matches: true, confidence: 0.85, reason: 'matches' }),
    });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await selectProcedure({
        conversa_id: 'c1',
        current_message: 'novo lead pra inglês',
        current_execution: null,
      });
      expect(result.decision).toBe('start');
      expect(result.selected_procedure_id).toBe(defId);

      // Now start execution
      const exec = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c1',
        first_step_id: 'step-1',
      });
      expect(exec.status).toBe('in_progress');
      expect(exec.current_step_id).toBe('step-1');
      expect(events.some((e) => e.event_type === 'execution_started')).toBe(true);
    });
  });

  it('cenário 3: execution ativa + machine_check passa → step avança', async () => {
    const defId = 'def-test';
    definitions[defId] = {
      id: defId,
      nome: 'test',
      version_number: 1,
      status: 'active',
      intencao: 'test',
      when_apply: {},
      steps: [
        { id: 'step-1', intencao: 'X', como: 'Y', sucesso_criteria_ref: 'crit-1' },
        { id: 'step-2', intencao: 'Z', como: 'W', depends_on: ['step-1'] },
      ],
      success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'confirmado' }],
    };

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c2',
        first_step_id: 'step-1',
      });

      const evalResult = evaluateCurrentStep({
        execution: exec,
        definition: definitions[defId],
        response_context: { response_text: 'Dado foi confirmado pelo cliente' },
      });
      expect(evalResult.step_completed).toBe(true);
      expect(evalResult.next_step_id).toBe('step-2');

      await engine.advanceStep({
        execution_id: exec.id,
        next_step_id: 'step-2',
        completed_step_id: 'step-1',
      });
      expect(execState[exec.id].current_step_id).toBe('step-2');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('cenário 4: replay reconstrói state a partir de events', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await engine.startExecution({
        definition_id: 'def-x',
        definition_version: 1,
        conversa_id: 'c3',
        first_step_id: 'step-1',
      });
      await engine.advanceStep({ execution_id: exec.id, next_step_id: 'step-2', completed_step_id: 'step-1' });
      await engine.advanceStep({ execution_id: exec.id, next_step_id: null, completed_step_id: 'step-2' });
      await engine.completeExecution({ execution_id: exec.id, outcome: 'success' });

      const state = await engine.replayState(exec.id);
      expect(state.status).toBe('completed');
      expect(state.completed_steps).toContain('step-1');
      expect(state.completed_steps).toContain('step-2');
    });
  });

  it('cenário 5: abortExecution finaliza com status=aborted + event', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const exec = await engine.startExecution({
        definition_id: 'def-y',
        definition_version: 1,
        conversa_id: 'c4',
        first_step_id: 'step-1',
      });
      await engine.abortExecution({ execution_id: exec.id, reason: 'user_change_of_mind' });

      expect(execState[exec.id].status).toBe('aborted');
      expect(execState[exec.id].notes).toBe('user_change_of_mind');
      expect(events.some((e) => e.event_type === 'execution_aborted')).toBe(true);
    });
  });
});
