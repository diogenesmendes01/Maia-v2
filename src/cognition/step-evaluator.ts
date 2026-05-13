import type { ProcedureExecution, ProcedureDefinition } from '@/db/schema.js';

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
};

export function evaluateCurrentStep(args: {
  execution: ProcedureExecution;
  definition: ProcedureDefinition;
  response_context: ResponseContext;
}): StepEvalResult {
  const steps = args.definition.steps as unknown as Step[];
  const criteria = args.definition.success_criteria as unknown as Criterion[];
  const currentStepId = args.execution.current_step_id;

  if (!currentStepId) {
    return { step_completed: false, criterion_results: [], next_step_id: null, failure_detected: false };
  }

  const currentStep = steps.find((s) => s.id === currentStepId);
  if (!currentStep) {
    return { step_completed: false, criterion_results: [], next_step_id: null, failure_detected: false };
  }

  // Find criteria for this step (via sucesso_criteria_ref)
  const stepCriteria = currentStep.sucesso_criteria_ref
    ? criteria.filter((c) => c.id === currentStep.sucesso_criteria_ref)
    : [];

  const criterion_results: StepEvalResult['criterion_results'] = [];
  let all_passed = stepCriteria.length > 0;
  const any_failure = false;

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
    } else {
      // P3b: llm_judge / user_signal / human_confirmed — not evaluated yet
      passed = false;
      evidence = `criterion type ${c.type} not evaluated in P3b`;
      // Don't mark as failure — just incomplete (P3c handles)
    }

    if (!passed) all_passed = false;
    criterion_results.push({ id: c.id, type: c.type, passed, evidence });
  }

  let next_step_id: string | null = null;
  if (all_passed) {
    // Find next step (one whose depends_on includes currentStepId AND not already completed)
    const completed = (args.execution.completed_steps as unknown as string[]) ?? [];
    const newCompleted = [...completed, currentStepId];
    const nextStep = steps.find((s) => {
      if (newCompleted.includes(s.id)) return false;
      const deps = s.depends_on ?? [];
      return deps.length === 0 || deps.every((d) => newCompleted.includes(d));
    });
    next_step_id = nextStep?.id ?? null;
  }

  return {
    step_completed: all_passed,
    criterion_results,
    next_step_id,
    failure_detected: any_failure,
  };
}
