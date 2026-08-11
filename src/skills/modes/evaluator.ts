/**
 * P9a — `evaluator` execution mode.
 *
 * Modo 4: skill avalia output de outra skill ou candidato qualquer e
 * retorna `{ score, verdict, reasons }`. Estrutura de input esperada:
 *   { candidate_output: unknown, baseline?: unknown, context?: unknown }
 *
 * Master spec §2.4 (evaluator skills usadas pelo capability-test-runner
 * em P5 estendido).
 *
 * Saída esperada (forma rígida):
 *   { score: number 0..1, verdict: 'pass'|'fail', reasons: string[] }
 */
import { callLLM } from '@/lib/claude.js';
import type { ModeContext } from '../types.js';

interface ProcedureSpec {
  system_prompt?: string;
  rubric?: string;
  template?: string;
}

export interface EvaluatorOutput {
  score: number;
  verdict: 'pass' | 'fail';
  reasons: string[];
}

export async function evaluatorMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const procedure = (ctx.skill.procedure ?? {}) as ProcedureSpec;
  const hints = (ctx.skill.runtime_hints ?? {}) as Record<string, unknown>;

  const system =
    procedure.system_prompt ??
    procedure.rubric ??
    procedure.template ??
    'You are an evaluator. Compare candidate_output against baseline. ' +
      'Return strict JSON: { "score": 0..1, "verdict": "pass" | "fail", "reasons": [string] }. ' +
      'Score >= 0.7 should map to verdict=pass.';

  const max_tokens = typeof hints.max_output_tokens === 'number' ? hints.max_output_tokens : 1024;

  // Honor caller cancellation before issuing the LLM call. Mirrors the
  // tool-mediated pattern and avoids spending tokens on a request that the
  // SkillRunner has already given up on. Issue #220.
  if (ctx.signal?.aborted) {
    throw new Error('aborted');
  }

  const res = await callLLM({
    workload: 'skill',
    system,
    messages: [{ role: 'user', content: JSON.stringify(ctx.input) }],
    max_tokens,
    temperature: 0.0, // determinístico para evaluator
    // Forwarded so the underlying SDK actually cancels the HTTP request when
    // the SkillRunner aborts (timeout or external cancellation). Issue #220.
    signal: ctx.signal,
  });

  const parsed = parseEvaluatorOutput(res.content ?? '');
  return parsed as unknown as Record<string, unknown>;
}

export function parseEvaluatorOutput(text: string): EvaluatorOutput {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('evaluator_empty_response');
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (!fenceMatch || !fenceMatch[1]) throw new Error('evaluator_invalid_json');
    raw = JSON.parse(fenceMatch[1]);
  }
  if (!raw || typeof raw !== 'object') throw new Error('evaluator_invalid_shape');
  const obj = raw as Record<string, unknown>;
  const score = typeof obj.score === 'number' ? obj.score : NaN;
  const verdict = obj.verdict === 'pass' || obj.verdict === 'fail' ? obj.verdict : null;
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : [];
  if (Number.isNaN(score) || score < 0 || score > 1) {
    throw new Error(`evaluator_invalid_score: ${String(obj.score)}`);
  }
  if (!verdict) {
    throw new Error(`evaluator_invalid_verdict: ${String(obj.verdict)}`);
  }
  return { score, verdict, reasons };
}
