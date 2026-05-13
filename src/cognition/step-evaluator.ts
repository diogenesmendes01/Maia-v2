import type { ProcedureExecution, ProcedureDefinition } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { judgeStepCriterion } from './step-evaluator-llm-judge.js';

type Criterion = {
  id: string;
  type: 'machine_check' | 'tool_result' | 'user_signal' | 'llm_judge' | 'human_confirmed';
  [k: string]: unknown;
};

type Step = {
  id: string;
  sucesso_criteria_ref?: string;
  depends_on?: string[];
  [k: string]: unknown;
};

export type ResponseContext = {
  response_text?: string;
  tools_called?: Array<{ name: string; result: unknown }>;
};

export type StepEvalResult = {
  step_completed: boolean;
  criterion_results: Array<{ id: string; type: string; passed: boolean; evidence: string }>;
  next_step_id: string | null;
  failure_detected: boolean;
  /**
   * P84-C3: signal back to the caller when the current step cannot make
   * progress on its own — typically because it has no criteria defined.
   * The runtime treats this as `step_failed` with reason `no_criteria_defined`
   * so the executor can record an event and (in P3c) the reaper can sweep.
   * Today: surfaced as a warning + audit event so the stall is observable.
   */
  stall_reason: null | 'no_criteria_defined' | 'unsupported_criterion_only';
  /**
   * P84-C3: when more than one downstream step is eligible to fire from
   * the current completion (DAG parallel branches), the evaluator picks
   * deterministically by array order and reports the alternates here so
   * the audit log can show that a DAG was linearized.
   */
  branch_alternates: string[];
};

export async function evaluateCurrentStep(args: {
  execution: ProcedureExecution;
  definition: ProcedureDefinition;
  response_context: ResponseContext;
}): Promise<StepEvalResult> {
  const steps = args.definition.steps as unknown as Step[];
  const criteria = args.definition.success_criteria as unknown as Criterion[];
  const currentStepId = args.execution.current_step_id;

  if (!currentStepId) {
    return {
      step_completed: false,
      criterion_results: [],
      next_step_id: null,
      failure_detected: false,
      stall_reason: null,
      branch_alternates: [],
    };
  }

  const currentStep = steps.find((s) => s.id === currentStepId);
  if (!currentStep) {
    return {
      step_completed: false,
      criterion_results: [],
      next_step_id: null,
      failure_detected: false,
      stall_reason: null,
      branch_alternates: [],
    };
  }

  // Find criteria for this step (via sucesso_criteria_ref)
  const stepCriteria = currentStep.sucesso_criteria_ref
    ? criteria.filter((c) => c.id === currentStep.sucesso_criteria_ref)
    : [];

  const criterion_results: StepEvalResult['criterion_results'] = [];
  let all_passed = stepCriteria.length > 0;
  const any_failure = false;

  // P84-C3: track whether every criterion on this step is one the P3b
  // engine can't evaluate (llm_judge, user_signal, human_confirmed). If
  // so, the step is stuck waiting on P3c and we should flag it rather
  // than silently looping forever.
  let unsupported_count = 0;

  for (const c of stepCriteria) {
    let passed = false;
    let evidence = '';

    if (c.type === 'machine_check') {
      const expr = c.expression as string;
      const text = args.response_context.response_text ?? '';
      try {
        const re = new RegExp(expr, 'i');
        passed = re.test(text);
        evidence = passed ? `regex match: ${expr}` : `no match for: ${expr}`;
      } catch {
        // Not a regex — treat as literal substring
        passed = text.toLowerCase().includes(expr.toLowerCase());
        evidence = passed ? `substring match: ${expr}` : `no substring match: ${expr}`;
      }
    } else if (c.type === 'tool_result') {
      const tool = c.tool as string;
      const expected = c.expected as string;
      const calls = args.response_context.tools_called ?? [];
      const matchingCall = calls.find((tc) => tc.name === tool);
      if (matchingCall) {
        const resultStr = typeof matchingCall.result === 'string' ? matchingCall.result : JSON.stringify(matchingCall.result);
        passed = resultStr.toLowerCase().includes(expected.toLowerCase());
        evidence = passed ? `tool ${tool} returned expected` : `tool ${tool} returned: ${resultStr.slice(0, 100)}`;
      } else {
        passed = false;
        evidence = `tool ${tool} not called`;
      }
    } else if (c.type === 'llm_judge') {
      // P3c Task 4: chamada ao Haiku via runCognitiveModule wrapper.
      // judgeStepCriterion JÁ embute timeout + fallback determinístico —
      // não propaga exceção, no pior caso retorna passed=false com reasoning
      // 'judge_timeout_or_error'. Threshold default 0.7 quando ausente.
      const threshold = typeof c.threshold === 'number' ? (c.threshold as number) : 0.7;
      const judge = await judgeStepCriterion({
        prompt: c.prompt as string,
        threshold,
        response_text: args.response_context.response_text ?? '',
        rubric: c.rubric as string | undefined,
      });
      passed = judge.passed;
      evidence = `judge score=${judge.score.toFixed(2)} threshold=${threshold}: ${judge.reasoning}`;
    } else if (c.type === 'user_signal') {
      // P3c Task 5 (próximo commit): detecção de sinal explícito do usuário
      // a partir do inbound textual. Por ora segue como "not evaluated".
      passed = false;
      evidence = `criterion type ${c.type} not evaluated yet (Task 5)`;
      unsupported_count += 1;
      // Don't mark as failure — just incomplete (P3c handles)
    } else if (c.type === 'human_confirmed') {
      // P3c Task 6 (próximo commit): exige confirmação de um humano com
      // role específica (ex.: owner) via flag explícita. Idem ao acima.
      passed = false;
      evidence = `criterion type ${c.type} not evaluated yet (Task 6)`;
      unsupported_count += 1;
      // Don't mark as failure — just incomplete (P3c handles)
    }

    if (!passed) all_passed = false;
    criterion_results.push({ id: c.id, type: c.type, passed, evidence });
  }

  // P84-C3: detect stalls.
  // (a) Step has no criteria → it can never auto-advance from machine
  // evaluation. We surface this so the runtime can emit a step_failed
  // event with reason 'no_criteria_defined' and the reaper can sweep.
  // We deliberately do NOT auto-advance — that would silently mask
  // procedure-definition bugs in production.
  // (b) Step has only P3c-only criteria → the engine can't evaluate any
  // of them; flag as 'unsupported_criterion_only' so observability picks
  // it up. The selector/reaper handles the rest.
  let stall_reason: StepEvalResult['stall_reason'] = null;
  if (stepCriteria.length === 0) {
    stall_reason = 'no_criteria_defined';
    logger.warn(
      {
        execution_id: args.execution.id,
        step_id: currentStepId,
        definition_id: args.execution.definition_id,
      },
      'step_evaluator.stall.no_criteria_defined',
    );
  } else if (unsupported_count === stepCriteria.length) {
    stall_reason = 'unsupported_criterion_only';
  }

  let next_step_id: string | null = null;
  const branch_alternates: string[] = [];
  if (all_passed) {
    // P84-C3: deterministic DAG-aware next-step picker.
    //
    // Before: `Array.prototype.find` returned the FIRST step whose
    // dependencies were satisfied — for DAGs with parallel branches
    // (e.g. `step-2a` + `step-2b` both depending on `step-1`), only the
    // one declared first ever fired. Worse: if step ordering wasn't
    // topological, a step whose deps happened to be partially satisfied
    // through another path could be picked out of order.
    //
    // After: gather ALL eligible candidates (deps satisfied, not yet
    // completed, not the current step). Pick the first deterministically
    // by array order (= definition-time order). Report the alternates
    // so the audit log can show a DAG was linearized. P3c will replace
    // this with explicit branch resolution via `branch_taken` events;
    // until then, the deterministic pick + warning is the safe MVP.
    const completed = (args.execution.completed_steps as unknown as string[]) ?? [];
    const newCompleted = [...completed, currentStepId];

    const eligible = steps.filter((s) => {
      if (s.id === currentStepId) return false;
      if (newCompleted.includes(s.id)) return false;
      const deps = s.depends_on ?? [];
      return deps.length === 0 || deps.every((d) => newCompleted.includes(d));
    });

    if (eligible.length > 1) {
      logger.warn(
        {
          execution_id: args.execution.id,
          completed_step_id: currentStepId,
          candidates: eligible.map((e) => e.id),
        },
        'step_evaluator.dag.parallel_branches_linearized',
      );
    }

    next_step_id = eligible[0]?.id ?? null;
    for (let i = 1; i < eligible.length; i++) {
      const alt = eligible[i];
      if (alt) branch_alternates.push(alt.id);
    }
  }

  return {
    step_completed: all_passed,
    criterion_results,
    next_step_id,
    failure_detected: any_failure,
    stall_reason,
    branch_alternates,
  };
}
