import { procedureExecutionsRepo, procedureExecutionEventsRepo } from '@/db/repositories.js';
import type { ProcedureExecution } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';

export async function startExecution(args: {
  definition_id: string;
  definition_version: number;
  conversa_id: string | null;
  first_step_id: string | null;
}): Promise<ProcedureExecution> {
  const exec = await procedureExecutionsRepo.create({
    definition_id: args.definition_id,
    definition_version: args.definition_version,
    conversa_id: args.conversa_id,
    status: 'in_progress',
    current_step_id: args.first_step_id,
    execution_state: {},
    completed_steps: [],
    ended_at: null,
    outcome: null,
    notes: null,
  } as any);

  await procedureExecutionEventsRepo.record({
    execution_id: exec.id,
    step_id: args.first_step_id,
    event_type: 'execution_started',
    payload: { definition_id: args.definition_id, definition_version: args.definition_version, first_step_id: args.first_step_id },
    confidence: null,
  } as any);

  return exec;
}

export async function recordEvent(args: {
  execution_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  step_id?: string | null;
  confidence?: number | null;
}): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: args.step_id ?? null,
    event_type: args.event_type,
    payload: args.payload,
    confidence: args.confidence ?? null,
  } as any);
}

export async function advanceStep(args: {
  execution_id: string;
  next_step_id: string | null;
  completed_step_id: string;
}): Promise<void> {
  const exec = await procedureExecutionsRepo.findById(args.execution_id);
  if (!exec) {
    logger.warn({ execution_id: args.execution_id }, 'procedure_engine.advance.missing_execution');
    return;
  }

  const completed = (exec.completed_steps as unknown as string[]) ?? [];
  const newCompleted = [...completed, args.completed_step_id];

  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: args.completed_step_id,
    event_type: 'step_completed',
    payload: { completed_step_id: args.completed_step_id, next_step_id: args.next_step_id },
    confidence: null,
  } as any);

  if (args.next_step_id) {
    await procedureExecutionEventsRepo.record({
      execution_id: args.execution_id,
      step_id: args.next_step_id,
      event_type: 'step_started',
      payload: {},
      confidence: null,
    } as any);
  }

  await procedureExecutionsRepo.updateState(args.execution_id, {
    current_step_id: args.next_step_id ?? undefined,
    completed_steps: newCompleted as any,
  });
}

export async function completeExecution(args: {
  execution_id: string;
  outcome: 'success' | 'failure' | 'partial' | 'escalated' | 'no_response';
}): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: null,
    event_type: 'execution_completed',
    payload: { outcome: args.outcome },
    confidence: null,
  } as any);

  await procedureExecutionsRepo.updateState(args.execution_id, {
    status: 'completed',
    outcome: args.outcome,
    ended_at: new Date(),
  });
}

export async function abortExecution(args: { execution_id: string; reason: string }): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: null,
    event_type: 'execution_aborted',
    payload: { reason: args.reason },
    confidence: null,
  } as any);

  await procedureExecutionsRepo.updateState(args.execution_id, {
    status: 'aborted',
    notes: args.reason,
    ended_at: new Date(),
  });
}

/**
 * P3c Task 6: registra uma confirmação humana (approved | rejected) como evento
 * event-sourced. O step-evaluator consulta o evento mais recente via
 * {@link getLatestHumanConfirmation} para decidir o critério `human_confirmed`.
 *
 * Não muta o estado da execution diretamente — apenas append. A decisão de
 * avançar/abortar é responsabilidade do evaluator + advanceStep no turno
 * seguinte.
 */
export async function recordHumanConfirmation(args: {
  execution_id: string;
  step_id: string;
  operator_id: string;
  decision: 'approved' | 'rejected';
  notes?: string;
}): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: args.step_id,
    event_type: 'human_confirmation',
    payload: {
      step_id: args.step_id,
      operator_id: args.operator_id,
      decision: args.decision,
      notes: args.notes ?? null,
    },
    confidence: null,
  } as any);
}

/**
 * P3c Task 6: busca a confirmação humana mais recente para um (execution_id,
 * step_id). Retorna null se não houver. LIFO sobre a lista ordenada por
 * created_at (asc, vinda do repo) — itera de trás pra frente.
 *
 * Eventos com payload inválido (sem step_id correto, ou decision != approved
 * | rejected) são ignorados em vez de lançar — defensivo contra evolução de
 * schema.
 */
export async function getLatestHumanConfirmation(args: {
  execution_id: string;
  step_id: string;
}): Promise<{ decision: 'approved' | 'rejected'; operator_id: string; ts: Date } | null> {
  const events = await procedureExecutionEventsRepo.listByExecution(args.execution_id);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.event_type !== 'human_confirmation') continue;
    const p = e.payload as { step_id?: string; decision?: string; operator_id?: string } | null;
    if (!p || p.step_id !== args.step_id) continue;
    if (p.decision !== 'approved' && p.decision !== 'rejected') continue;
    return {
      decision: p.decision,
      operator_id: p.operator_id ?? 'unknown',
      ts: e.created_at,
    };
  }
  return null;
}

export async function replayState(execution_id: string): Promise<{
  current_step_id: string | null;
  completed_steps: string[];
  status: string;
}> {
  const events = await procedureExecutionEventsRepo.listByExecution(execution_id);
  let current_step_id: string | null = null;
  const completed_steps: string[] = [];
  let status = 'in_progress';

  for (const e of events) {
    if (e.event_type === 'execution_started') {
      current_step_id = ((e.payload as Record<string, unknown>)?.['first_step_id'] as string | null) ?? null;
    } else if (e.event_type === 'step_started') {
      current_step_id = e.step_id;
    } else if (e.event_type === 'step_completed') {
      if (e.step_id) completed_steps.push(e.step_id);
    } else if (e.event_type === 'execution_completed') {
      status = 'completed';
    } else if (e.event_type === 'execution_aborted') {
      status = 'aborted';
    }
  }

  return { current_step_id, completed_steps, status };
}
