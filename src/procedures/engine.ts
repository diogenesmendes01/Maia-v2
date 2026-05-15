import { procedureExecutionsRepo, procedureExecutionEventsRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import type { ProcedureExecution } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';

/**
 * P84-C2 + P84-C5: startExecution is idempotent under concurrency.
 *
 * Returns the existing in_progress execution if another worker won the
 * race (the partial UNIQUE index from migration 023 prevents duplicate
 * rows; the `created: false` flag tells callers a conflict happened so
 * they can skip emitting `execution_started`).
 *
 * The execution row INSERT and the execution_started event INSERT commit
 * inside a single transaction, so a crash between them can't leave an
 * execution without its origin event.
 */
export async function startExecution(args: {
  definition_id: string;
  definition_version: number;
  conversa_id: string | null;
  first_step_id: string | null;
}): Promise<{ execution: ProcedureExecution; created: boolean }> {
  return withTx(async (tx) => {
    const { execution, created } = await procedureExecutionsRepo.createOrFindActive({
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
    });

    if (created) {
      await procedureExecutionEventsRepo.recordTx(tx, {
        execution_id: execution.id,
        step_id: args.first_step_id,
        event_type: 'execution_started',
        payload: {
          definition_id: args.definition_id,
          definition_version: args.definition_version,
          first_step_id: args.first_step_id,
        },
        confidence: null,
      });
    } else {
      // Concurrent-start race: another worker just inserted the in_progress
      // row. Skip the `execution_started` event (the winner already emitted
      // it inside its own transaction) and log so observability is intact.
      logger.warn(
        {
          execution_id: execution.id,
          conversa_id: args.conversa_id,
          definition_id: args.definition_id,
        },
        'procedure_engine.start.concurrent_race_lost',
      );
    }

    return { execution, created };
  });
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
    confidence: confidenceToColumn(args.confidence),
  });
}

/**
 * P84-C4: emit `criterion_checked` events for every gate evaluation.
 *
 * This is what makes the audit trail answer the postmortem question
 * "why did step X not advance?" — without these events, every step
 * evaluation is invisible after the fact.
 */
export async function recordCriterionChecked(args: {
  execution_id: string;
  step_id: string;
  criterion_id: string;
  criterion_type: string;
  passed: boolean;
  evidence: string;
  confidence?: number | null;
}): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: args.step_id,
    event_type: 'criterion_checked',
    payload: {
      criterion_id: args.criterion_id,
      criterion_type: args.criterion_type,
      passed: args.passed,
      evidence: args.evidence,
    },
    confidence: confidenceToColumn(args.confidence),
  });
}

/**
 * P84-C4: emit `tool_called` events when a procedure step triggers a tool.
 *
 * Wired from the post-turn evaluator using the ReAct loop's
 * `tools_called` capture, restricted to tools that intersect with the
 * current step's success criteria (i.e., tools the procedure actually
 * cares about — not every tool the LLM happened to call).
 */
export async function recordToolCalled(args: {
  execution_id: string;
  step_id: string | null;
  tool_name: string;
  result: unknown;
}): Promise<void> {
  await procedureExecutionEventsRepo.record({
    execution_id: args.execution_id,
    step_id: args.step_id,
    event_type: 'tool_called',
    payload: {
      tool_name: args.tool_name,
      // Trim oversized payloads — audit trail, not full result archive.
      result: truncateForAudit(args.result),
    },
    confidence: null,
  });
}

function truncateForAudit(v: unknown): unknown {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= 4096) return v;
    return { _truncated: true, preview: s.slice(0, 4000), original_length: s.length };
  } catch {
    return { _unserializable: true };
  }
}

// PR #84 Minor #1: Drizzle infers `numeric(p,s)` columns as `string | null`
// even though callers pass a JS number. Centralize the coercion so call sites
// can use the natural number type and the type cast lives in one place
// (instead of `as any` on every event insert).
function confidenceToColumn(c: number | null | undefined): string | null {
  return c == null ? null : c.toString();
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

  // P84-C5: atomicity. Without the transaction, a crash between the
  // step_completed event INSERT and the procedure_executions UPDATE
  // produces permanent divergence — `replayState` would correctly show
  // step N completed, but `procedure_executions.current_step_id` still
  // lies. Both writes commit together or neither does.
  await withTx(async (tx) => {
    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: args.completed_step_id,
      event_type: 'step_completed',
      payload: { completed_step_id: args.completed_step_id, next_step_id: args.next_step_id },
      confidence: null,
    });

    if (args.next_step_id) {
      await procedureExecutionEventsRepo.recordTx(tx, {
        execution_id: args.execution_id,
        step_id: args.next_step_id,
        event_type: 'step_started',
        payload: {},
        confidence: null,
      });
    }

    // P84-C4: emit `state_updated` for replay reconstructibility. Without
    // this, the derived `current_step_id`/`completed_steps` columns can
    // only be observed from the row — never reconstructed from the event
    // log, which is what "event-sourced truth" claims to provide.
    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: args.next_step_id ?? args.completed_step_id,
      event_type: 'state_updated',
      payload: {
        current_step_id: args.next_step_id,
        completed_steps: newCompleted,
      },
      confidence: null,
    });

    await procedureExecutionsRepo.updateStateTx(tx, args.execution_id, {
      current_step_id: args.next_step_id,
      completed_steps: newCompleted,
    });
  });
}

export async function completeExecution(args: {
  execution_id: string;
  outcome: 'success' | 'failure' | 'partial' | 'escalated' | 'no_response';
}): Promise<void> {
  // P84-C5: atomicity. `execution_completed` event + status flip commit
  // together. A crash between them would leave an `in_progress` row with
  // a `completed` event terminating its log — replay would show
  // completion but the active-find path would still return the row.
  await withTx(async (tx) => {
    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: null,
      event_type: 'execution_completed',
      payload: { outcome: args.outcome },
      confidence: null,
    });

    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: null,
      event_type: 'state_updated',
      payload: { status: 'completed', outcome: args.outcome },
      confidence: null,
    });

    await procedureExecutionsRepo.updateStateTx(tx, args.execution_id, {
      status: 'completed',
      outcome: args.outcome,
      ended_at: new Date(),
    });
  });
}

export async function abortExecution(args: { execution_id: string; reason: string }): Promise<void> {
  // P84-C5: atomicity. Same rationale as completeExecution.
  await withTx(async (tx) => {
    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: null,
      event_type: 'execution_aborted',
      payload: { reason: args.reason },
      confidence: null,
    });

    await procedureExecutionEventsRepo.recordTx(tx, {
      execution_id: args.execution_id,
      step_id: null,
      event_type: 'state_updated',
      payload: { status: 'aborted', notes: args.reason },
      confidence: null,
    });

    await procedureExecutionsRepo.updateStateTx(tx, args.execution_id, {
      status: 'aborted',
      notes: args.reason,
      ended_at: new Date(),
    });
  });
}

/**
 * P84-C4: replayState now consumes `state_updated` events too, so the
 * full set of derived fields can be reconstructed from the event log
 * alone (`outcome`, `notes`, plus `current_step_id`/`completed_steps`/
 * `status` as before). Older executions that pre-date the
 * `state_updated` emission still replay correctly because the legacy
 * `step_started`/`step_completed`/`execution_*` events carry the same
 * information.
 */
export async function replayState(execution_id: string): Promise<{
  current_step_id: string | null;
  completed_steps: string[];
  status: string;
  outcome: string | null;
  notes: string | null;
}> {
  const events = await procedureExecutionEventsRepo.listByExecution(execution_id);
  let current_step_id: string | null = null;
  const completed_steps: string[] = [];
  let status = 'in_progress';
  let outcome: string | null = null;
  let notes: string | null = null;

  for (const e of events) {
    const payload = (e.payload as Record<string, unknown>) ?? {};
    if (e.event_type === 'execution_started') {
      current_step_id = (payload['first_step_id'] as string | null) ?? null;
    } else if (e.event_type === 'step_started') {
      current_step_id = e.step_id;
    } else if (e.event_type === 'step_completed') {
      if (e.step_id) completed_steps.push(e.step_id);
    } else if (e.event_type === 'execution_completed') {
      status = 'completed';
      if (typeof payload['outcome'] === 'string') outcome = payload['outcome'] as string;
    } else if (e.event_type === 'execution_aborted') {
      status = 'aborted';
      if (typeof payload['reason'] === 'string') notes = payload['reason'] as string;
    } else if (e.event_type === 'state_updated') {
      // Authoritative state mutation — overrides anything inferred above.
      if ('current_step_id' in payload) {
        current_step_id = (payload['current_step_id'] as string | null) ?? current_step_id;
      }
      if (Array.isArray(payload['completed_steps'])) {
        // Replace, not append — state_updated carries the full list.
        completed_steps.length = 0;
        for (const s of payload['completed_steps'] as string[]) completed_steps.push(s);
      }
      if (typeof payload['status'] === 'string') status = payload['status'] as string;
      if (typeof payload['outcome'] === 'string') outcome = payload['outcome'] as string;
      if (typeof payload['notes'] === 'string') notes = payload['notes'] as string;
    }
  }

  return { current_step_id, completed_steps, status, outcome, notes };
}
