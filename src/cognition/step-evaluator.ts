import type { ProcedureExecution, ProcedureDefinition } from '@/db/schema.js';
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
    } else if (c.type === 'human_confirmed') {
      // P3c Task 6 (próximo commit): exige confirmação de um humano com
      // role específica (ex.: owner) via flag explícita. Idem ao acima.
      passed = false;
      evidence = `criterion type ${c.type} not evaluated yet (Task 6)`;
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
