import { runCognitiveModule } from './runner.js';
import { callLLM } from '@/lib/claude.js';
import { isLLMConfigured } from '@/lib/llm/index.js';

/**
 * LLM-as-judge para critérios subjetivos de procedure steps.
 *
 * P3c Task 4: avalia se a resposta da Maia cumpre um critério em linguagem
 * natural (`prompt`), com `rubric` opcional. Retorna score 0-1 + reasoning;
 * `passed` é derivado de `score >= threshold`.
 *
 * Wrapped em `runCognitiveModule` para timeout (5s), fallback determinístico
 * (`passed=false` com reasoning `judge_timeout_or_error`) e audit log via
 * `cognitive_module_log`. NUNCA propaga exceção — pior caso retorna fallback.
 */
export type LLMJudgeInput = {
  prompt: string;
  threshold: number;
  response_text: string;
  rubric?: string;
};

export type LLMJudgeResult = {
  passed: boolean;
  score: number;
  reasoning: string;
};

// Issue #508: o slug do juiz deixou de morar aqui. O tier (`fast`) vem da
// política do workload `step_evaluator` e o slug efetivo das settings
// dinâmicas — o operador troca o modelo pelo Admin, não por deploy.
const JUDGE_TIMEOUT_MS = 5000;

const FALLBACK_RESULT: LLMJudgeResult = {
  passed: false,
  score: 0,
  reasoning: 'judge_timeout_or_error',
};

// PR #85 fix P85-I5 — distinct reasoning when the deploy is misconfigured
// (no ANTHROPIC_API_KEY). Without this branch, every `llm_judge` criterion
// silently fails with `judge_timeout_or_error`, indistinguishable from the
// judge legitimately scoring the response low. Ops needs a signal that
// the failure is configuration-class, not content-class — distinct
// reasoning shows up in `cognitive_module_log` so the audit trail
// differentiates the two.
const MISSING_API_KEY_RESULT: LLMJudgeResult = {
  passed: false,
  score: 0,
  reasoning: 'judge_missing_api_key',
};

export async function judgeStepCriterion(input: LLMJudgeInput): Promise<LLMJudgeResult> {
  // Short-circuit BEFORE calling runCognitiveModule so the missing-key
  // result is exposed as the module output (and therefore audited as such)
  // rather than degrading into the generic timeout/error fallback path.
  // Issue #508: a checagem passa a ser sobre o provider ATIVO. Antes, um
  // deploy com LLM_PROVIDER=openrouter e sem ANTHROPIC_API_KEY caía aqui
  // mesmo tendo LLM perfeitamente configurado.
  if (!isLLMConfigured()) {
    return { ...MISSING_API_KEY_RESULT };
  }

  const result = await runCognitiveModule<LLMJudgeResult>(
    {
      name: 'step_evaluator_llm_judge',
      triggered_by: 'sync_conditional',
      timeoutMs: JUDGE_TIMEOUT_MS,
      fallback: () => ({ ...FALLBACK_RESULT }),
    },
    async () => {
      const system = [
        'Você é um avaliador objetivo de respostas de um agente.',
        'Dado um CRITÉRIO em linguagem natural, opcionalmente um RUBRIC, e a RESPOSTA do agente,',
        'devolva APENAS um JSON com a forma {"score": <0..1>, "reasoning": "<curto>"}.',
        '0 = não cumpre nada; 1 = cumpre perfeitamente. Valores intermediários para cumprimento parcial.',
        'Não inclua nenhum texto fora do JSON.',
      ].join('\n');

      const userParts: string[] = [`CRITÉRIO: ${input.prompt}`];
      if (input.rubric) userParts.push(`RUBRIC: ${input.rubric}`);
      userParts.push(`RESPOSTA: ${input.response_text}`);
      userParts.push('Devolva JSON com score (0-1) e reasoning curto (<=200 chars).');
      const userPrompt = userParts.join('\n\n');

      const completion = await callLLM({
        workload: 'step_evaluator',
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = completion.content ?? '';

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        return { passed: false, score: 0, reasoning: 'judge_returned_no_json' };
      }

      let parsed: { score?: unknown; reasoning?: unknown };
      try {
        parsed = JSON.parse(match[0]) as { score?: unknown; reasoning?: unknown };
      } catch {
        return { passed: false, score: 0, reasoning: 'judge_returned_invalid_json' };
      }

      const rawScore = typeof parsed.score === 'number' ? parsed.score : NaN;
      if (!Number.isFinite(rawScore)) {
        return { passed: false, score: 0, reasoning: 'judge_score_not_numeric' };
      }
      const score = Math.max(0, Math.min(1, rawScore));
      const reasoning =
        typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : '';
      return {
        passed: score >= input.threshold,
        score,
        reasoning,
      };
    },
  );

  return result.output ?? { ...FALLBACK_RESULT };
}
