import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from './runner.js';
import { config } from '@/config/env.js';

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

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_TIMEOUT_MS = 5000;

const FALLBACK_RESULT: LLMJudgeResult = {
  passed: false,
  score: 0,
  reasoning: 'judge_timeout_or_error',
};

export async function judgeStepCriterion(input: LLMJudgeInput): Promise<LLMJudgeResult> {
  const result = await runCognitiveModule<LLMJudgeResult>(
    {
      name: 'step_evaluator_llm_judge',
      triggered_by: 'sync_conditional',
      timeoutMs: JUDGE_TIMEOUT_MS,
      fallback: () => ({ ...FALLBACK_RESULT }),
    },
    async () => {
      const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? '' });
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

      const completion = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = (completion.content as Array<{ type: string; text?: string }>)
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');

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
