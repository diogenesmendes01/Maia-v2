/**
 * P9a — `tool_mediated` execution mode.
 *
 * Modo 3: dispatcher LLM-com-tools restrito por `skill.allowed_tools`. A
 * primeira interação do LLM pode produzir um ou mais `tool_use`; a skill
 * resolve cada tool via `dispatchToolByName` e devolve `tool_result`. O
 * loop encerra quando o LLM responde com `stop_reason='end_turn'` ou o
 * cap `max_tool_calls` é atingido (default 5).
 *
 * Master spec §2.4 + §3.4 (skill agent harness). Cada tool resolvida é
 * registrada em `tools_called` (passado para o trace pelo SkillRunner).
 *
 * Out-of-scope para P9a (TODOs anotados):
 *  - Resolução por-tool de policy_descriptors (cada tool pode ter sua
 *    própria política aplicada — P9d/P10 fará isso)
 *  - Streaming de tool_use (assumimos modo síncrono)
 */
import { callLLM, type LLMMessage, type ToolSchema } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import type { ModeContext } from '../types.js';

interface ProcedureSpec {
  system_prompt?: string;
  template?: string;
  tool_schemas?: ToolSchema[];
}

export interface ToolDispatcher {
  (name: string, args: unknown): Promise<unknown>;
}

let toolDispatcher: ToolDispatcher | null = null;

/**
 * Permite injeção do dispatcher de tools (real registry em produção;
 * mock em testes). Em ausência de dispatcher injetado, qualquer
 * tool_use lança `tool_dispatcher_not_configured`.
 */
export function setToolDispatcher(d: ToolDispatcher | null): void {
  toolDispatcher = d;
}

export async function toolMediatedMode(
  ctx: ModeContext,
): Promise<Record<string, unknown>> {
  const procedure = (ctx.skill.procedure ?? {}) as ProcedureSpec;
  const hints = (ctx.skill.runtime_hints ?? {}) as Record<string, unknown>;
  const allowedTools = (ctx.skill.allowed_tools ?? []) as string[];

  const system = procedure.system_prompt ?? procedure.template ?? '';
  const max_tokens = typeof hints.max_output_tokens === 'number' ? hints.max_output_tokens : 2048;
  const maxToolCalls = typeof hints.max_tool_calls === 'number' ? hints.max_tool_calls : 5;

  // Filter tool schemas to only those declared in allowed_tools (defense in depth).
  const tools: ToolSchema[] = (procedure.tool_schemas ?? []).filter((t) =>
    allowedTools.includes(t.name),
  );

  const messages: LLMMessage[] = [{ role: 'user', content: JSON.stringify(ctx.input) }];
  const toolsCalled: string[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i <= maxToolCalls; i++) {
    const res = await callLLM({
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens,
    });
    totalIn += res.usage.input_tokens;
    totalOut += res.usage.output_tokens;

    if (res.tool_uses.length === 0 || res.stop_reason === 'end_turn') {
      // No more tool calls — final answer is text content.
      const text = res.content ?? '';
      const parsed = safeParseJson(text);
      return { ...parsed, _tools_called: toolsCalled, _tokens_in: totalIn, _tokens_out: totalOut };
    }

    if (i === maxToolCalls) {
      throw new Error('max_tool_calls_exceeded');
    }

    // Append assistant turn with tool_uses
    messages.push({
      role: 'assistant',
      content: [
        ...(res.content ? [{ type: 'text' as const, text: res.content }] : []),
        ...res.tool_uses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.tool,
          input: tu.args,
        })),
      ],
    });

    // Dispatch each tool, append tool_results in a single user turn.
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];
    for (const tu of res.tool_uses) {
      if (!allowedTools.includes(tu.tool)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `tool_not_allowed: ${tu.tool}`,
          is_error: true,
        });
        continue;
      }
      if (!toolDispatcher) {
        throw new Error('tool_dispatcher_not_configured');
      }
      try {
        const result = await toolDispatcher(tu.tool, tu.args);
        toolsCalled.push(tu.tool);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const e = err as Error;
        logger.warn({ skill_id: ctx.skill.id, tool: tu.tool, err: e.message }, 'p9a.tool_dispatch_error');
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `error: ${e.message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('tool_loop_exhausted_without_resolution');
}

function safeParseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { text: trimmed };
  }
}
