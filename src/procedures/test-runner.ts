/**
 * P3c Task 7: sandbox test-runner.
 *
 * Executes a scripted scenario against a procedure definition without touching
 * the production runtime. Drives engine.startExecution → evaluateCurrentStep
 * → engine.advanceStep / engine.completeExecution, injecting scripted human
 * confirmations at the right step transitions.
 *
 * The runner is the engine behind the test gate (Task 8) and the explicit
 * `runProcedureTest` integration (Task 11). Always wraps execution in
 * `runWithTenantContext({ tenant_id: 'sandbox-test', agent_id: 'sandbox' })`
 * so sandbox executions are tenant-isolated from real traffic.
 *
 * Never throws — every error path becomes `{ status: 'error', details.error }`.
 */
import * as engine from '@/procedures/engine.js';
import { procedureExecutionsRepo } from '@/db/repositories.js';
import { evaluateCurrentStep } from '@/cognition/step-evaluator.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { ProcedureDefinition, ProcedureExecution } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';

export type ScenarioTurn =
  | { role: 'user'; message: string }
  | { role: 'agent'; response_text: string; tools_called?: Array<{ name: string; result: unknown }> };

export type Scenario = {
  turns: ScenarioTurn[];
  /** Inject human confirmations at scripted step transitions. Applied when
   *  current_step_id === at_step (after the agent turn that landed there). */
  human_confirmations?: Array<{ at_step: string; decision: 'approved' | 'rejected'; operator_id: string }>;
};

export type TestRunResult = {
  status: 'pass' | 'fail' | 'error';
  details: {
    expected_outcome: string;
    actual_outcome: string | null;
    expected_step_path?: string[];
    actual_step_path: string[];
    final_status: string;
    diff: string[];
    error?: string;
  };
};

const SANDBOX_TENANT = 'sandbox-test';
const SANDBOX_AGENT = 'sandbox';

export async function runProcedureTest(args: {
  test_id: string;
  definition: ProcedureDefinition;
  scenario: Scenario;
  expected_outcome: 'success' | 'failure' | 'partial' | 'escalated';
  expected_step_path?: string[];
}): Promise<TestRunResult> {
  return runWithTenantContext({ tenant_id: SANDBOX_TENANT, agent_id: SANDBOX_AGENT }, async () => {
    const actual_step_path: string[] = [];
    let actual_outcome: string | null = null;
    let final_status = 'not_started';
    let executionId: string | null = null;

    try {
      const steps = (args.definition.steps as unknown as Array<{ id: string; depends_on?: string[] }>) ?? [];
      const firstStep = steps.find((s) => !s.depends_on || s.depends_on.length === 0) ?? steps[0] ?? null;
      const firstStepId = firstStep?.id ?? null;

      const exec = await engine.startExecution({
        definition_id: args.definition.id,
        definition_version: args.definition.version_number,
        conversa_id: null,
        first_step_id: firstStepId,
      });
      executionId = exec.id;
      if (firstStepId) actual_step_path.push(firstStepId);

      let last_user_message = '';
      const pendingConfirmations = [...(args.scenario.human_confirmations ?? [])];

      for (const turn of args.scenario.turns) {
        if (turn.role === 'user') {
          last_user_message = turn.message;
          continue;
        }

        // turn.role === 'agent'
        // Refetch execution before each evaluation — engine.advanceStep may
        // have mutated state in the previous iteration.
        let current = await procedureExecutionsRepo.findById(exec.id);
        if (!current || current.status !== 'in_progress') break;

        let evalResult = await evaluateCurrentStep({
          execution: current,
          definition: args.definition,
          response_context: {
            response_text: turn.response_text,
            tools_called: turn.tools_called,
            user_message: last_user_message,
          },
        });

        // Apply any scripted confirmation for the CURRENT step BEFORE deciding
        // whether to advance — so an approval can flip a human_confirmed
        // criterion from awaiting → passed in the same agent turn.
        const stepBeforeConfirm = current.current_step_id;
        if (stepBeforeConfirm) {
          const idx = pendingConfirmations.findIndex((c) => c.at_step === stepBeforeConfirm);
          if (idx >= 0) {
            const confirmation = pendingConfirmations[idx]!;
            pendingConfirmations.splice(idx, 1);
            await engine.recordHumanConfirmation({
              execution_id: exec.id,
              step_id: stepBeforeConfirm,
              operator_id: confirmation.operator_id,
              decision: confirmation.decision,
            });
            // Re-evaluate now that the confirmation event exists.
            current = await procedureExecutionsRepo.findById(exec.id);
            if (current) {
              evalResult = await evaluateCurrentStep({
                execution: current,
                definition: args.definition,
                response_context: {
                  response_text: turn.response_text,
                  tools_called: turn.tools_called,
                  user_message: last_user_message,
                },
              });
            }
          }
        }

        if (!evalResult.step_completed) continue;

        const completedStepId = (current?.current_step_id ?? stepBeforeConfirm) as string;
        if (evalResult.next_step_id) {
          await engine.advanceStep({
            execution_id: exec.id,
            completed_step_id: completedStepId,
            next_step_id: evalResult.next_step_id,
          });
          actual_step_path.push(evalResult.next_step_id);
        } else {
          // No next step → final step done. Complete with success.
          await engine.advanceStep({
            execution_id: exec.id,
            completed_step_id: completedStepId,
            next_step_id: null,
          });
          await engine.completeExecution({ execution_id: exec.id, outcome: 'success' });
        }
      }

      // Observe final state. If still in_progress, the scenario ran out of
      // turns mid-procedure → outcome is `partial`.
      const finalExec = (await procedureExecutionsRepo.findById(exec.id)) as ProcedureExecution | null;
      if (finalExec) {
        final_status = finalExec.status;
        if (finalExec.outcome) {
          actual_outcome = finalExec.outcome;
        } else if (finalExec.status === 'in_progress') {
          actual_outcome = 'partial';
        } else if (finalExec.status === 'aborted') {
          actual_outcome = 'failure';
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ test_id: args.test_id, error }, 'procedure_test_runner.error');
      return {
        status: 'error',
        details: {
          expected_outcome: args.expected_outcome,
          actual_outcome,
          ...(args.expected_step_path ? { expected_step_path: args.expected_step_path } : {}),
          actual_step_path,
          final_status,
          diff: [],
          error,
        },
      };
    } finally {
      // Best-effort cleanup. The repos exposed by `src/db/repositories.ts`
      // currently don't expose a `delete` for procedure_executions; sandbox
      // tenant isolation keeps these rows from leaking into production reads.
      // If a delete method is added later this block becomes the natural hook.
      if (executionId) {
        const repoAny = procedureExecutionsRepo as unknown as { delete?: (id: string) => Promise<void> };
        if (typeof repoAny.delete === 'function') {
          try {
            await repoAny.delete(executionId);
          } catch (cleanupErr) {
            logger.warn(
              { execution_id: executionId, err: cleanupErr },
              'procedure_test_runner.cleanup_failed',
            );
          }
        }
      }
    }

    // Compute diff vs expectations.
    const diff: string[] = [];
    if (actual_outcome !== args.expected_outcome) {
      diff.push(`outcome: expected '${args.expected_outcome}', got '${actual_outcome ?? 'null'}'`);
    }
    if (args.expected_step_path) {
      const expected = args.expected_step_path;
      const same =
        expected.length === actual_step_path.length &&
        expected.every((s, i) => s === actual_step_path[i]);
      if (!same) {
        diff.push(
          `step_path: expected [${expected.join(' → ')}], got [${actual_step_path.join(' → ')}]`,
        );
      }
    }

    return {
      status: diff.length === 0 ? 'pass' : 'fail',
      details: {
        expected_outcome: args.expected_outcome,
        actual_outcome,
        ...(args.expected_step_path ? { expected_step_path: args.expected_step_path } : {}),
        actual_step_path,
        final_status,
        diff,
      },
    };
  });
}
