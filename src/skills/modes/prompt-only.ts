/**
 * P9a — `prompt_only` execution mode.
 *
 * Modo 1: chamada LLM simples com `skill.procedure.system_prompt` como
 * system + JSON.stringify(input) como mensagem do user. Saída esperada
 * é JSON parseável (validado externamente pelo SkillRunner via
 * `skill.output_schema`).
 *
 * `runtime_hints.preferred_model` e `max_output_tokens` são honrados.
 * Sem `preferred_model`, o `callLLM` usa o `mainModel` configurado.
 */
import { callLLM } from '@/lib/claude.js';
import type { ModeContext } from '../types.js';

interface ProcedureSpec {
  system_prompt?: string;
  template?: string;
}

export async function promptOnlyMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const procedure = (ctx.skill.procedure ?? {}) as ProcedureSpec;
  const hints = (ctx.skill.runtime_hints ?? {}) as Record<string, unknown>;
  const system = procedure.system_prompt ?? procedure.template ?? '';

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
    temperature: 0.2,
    // Forwarded so the underlying SDK actually cancels the HTTP request when
    // the SkillRunner aborts (timeout or external cancellation). Issue #220.
    signal: ctx.signal,
  });

  const text = res.content ?? '';
  return parseJsonResponse(text);
}

/**
 * Parser permissivo: aceita JSON puro ou texto com bloco de código JSON.
 * Sem JSON válido, lança erro — o SkillRunner converte em
 * `executor_error` no envelope de saída.
 */
export function parseJsonResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('empty_llm_response');
  }
  // Tenta direto
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // Tenta extrair entre ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenceMatch && fenceMatch[1]) {
      const parsed = JSON.parse(fenceMatch[1]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    }
    throw new Error('invalid_json_in_llm_response');
  }
}
