/**
 * P9a — `tool_mediated` execution mode.
 *
 * Modo 3: dispatcher LLM-com-tools restrito por `skill.allowed_tools`. A
 * primeira interação do LLM pode produzir um ou mais `tool_use`; a skill
 * resolve cada tool via `dispatchToolByName` e devolve `tool_result`. O
 * loop encerra quando o LLM responde com `stop_reason='end_turn'` ou o
 * cap `max_tool_calls` é atingido (default 5).
 *
 * Caps enforced (review #99 finding 3 + mission item 3):
 *  - `runtime_hints.max_tool_calls`: counter; ao exceder → BLOQUEIA novas
 *    tool calls e devolve resultado parcial. Audit log emitido.
 *  - `runtime_hints.max_tokens`: contador acumula
 *    `input_tokens + output_tokens` em cada iteração; ao exceder →
 *    TRUNCA o loop, emite warning `token_budget_exceeded`, e retorna o
 *    último conteúdo capturado.
 *  - AbortSignal: respeitado entre iterações; toolDispatcher recebe o
 *    signal para que tools side-effecting possam cancelar.
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
  (
    name: string,
    args: unknown,
    opts?: { signal?: AbortSignal; idempotency_key?: string },
  ): Promise<unknown>;
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
  // Total prompt+output token budget enforced across the loop (review #99
  // mission item 3). When exceeded, we truncate the loop and emit warning.
  const maxTokensBudget =
    typeof hints.max_tokens === 'number'
      ? hints.max_tokens
      : typeof hints.max_prompt_tokens === 'number'
      ? hints.max_prompt_tokens + max_tokens * (maxToolCalls + 1)
      : Number.POSITIVE_INFINITY;

  // Filter tool schemas to only those declared in allowed_tools (defense in depth).
  const tools: ToolSchema[] = (procedure.tool_schemas ?? []).filter((t) =>
    allowedTools.includes(t.name),
  );

  const messages: LLMMessage[] = [{ role: 'user', content: JSON.stringify(ctx.input) }];
  const toolsCalled: string[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let toolCallCount = 0;
  let lastContent: string | null = null;
  let tokenBudgetExceeded = false;
  let toolCapHit = false;

  // Generate an idempotency-key prefix that is stable per skill execution
  // attempt. Combined with the tool_use.id this gives each dispatch a
  // unique idempotency key the underlying tool can use to dedupe retries
  // (review #99 finding 3 recommendation).
  const idempotencyPrefix = `${ctx.skill.id}:${ctx.turno_id ?? ctx.conversa_id ?? Date.now()}`;

  // Safety upper bound for the loop: allow a few extra iterations beyond
  // max_tool_calls so the LLM can wrap up its answer after we soft-block
  // further tool dispatch (review #99 mission item 3). Throws
  // `max_tool_calls_exceeded` only if even this larger bound is exceeded
  // (defense against runaway LLM that keeps re-requesting tools).
  const loopUpperBound = maxToolCalls + 5;
  for (let i = 0; i <= loopUpperBound; i++) {
    // Pre-iteration abort check — caller / runner timeout cuts the loop
    // before issuing a new LLM call.
    if (ctx.signal?.aborted) {
      throw new Error('aborted');
    }
    const res = await callLLM({
      system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens,
    });
    totalIn += res.usage.input_tokens;
    totalOut += res.usage.output_tokens;
    if (res.content !== null) lastContent = res.content;

    // Token-budget enforcement (review #99 mission item 3): truncate
    // before issuing further tool calls or new iterations.
    if (totalIn + totalOut > maxTokensBudget) {
      tokenBudgetExceeded = true;
      logger.warn(
        {
          skill_id: ctx.skill.id,
          tokens_in: totalIn,
          tokens_out: totalOut,
          budget: maxTokensBudget,
        },
        'p9a.tool_mediated.token_budget_exceeded',
      );
      break;
    }

    if (res.tool_uses.length === 0 || res.stop_reason === 'end_turn') {
      // No more tool calls — final answer is text content.
      const parsed = safeParseJson(lastContent ?? '');
      return {
        ...parsed,
        _tools_called: toolsCalled,
        _tokens_in: totalIn,
        _tokens_out: totalOut,
        _token_budget_exceeded: tokenBudgetExceeded,
        _tool_cap_hit: toolCapHit,
      };
    }

    if (i === loopUpperBound) {
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
      // Cap enforcement (review #99 mission item 3): when we have already
      // reached the cap, refuse further dispatch and emit a tool_result
      // marking it so the LLM stops. We do NOT raise — partial-result
      // path is preferable for the agent to wrap up its answer.
      if (toolCallCount >= maxToolCalls) {
        toolCapHit = true;
        logger.warn(
          { skill_id: ctx.skill.id, max_tool_calls: maxToolCalls, tool: tu.tool },
          'p9a.tool_mediated.tool_call_cap_hit',
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'tool_call_cap_reached',
          is_error: true,
        });
        continue;
      }
      // Abort check before dispatch (review #99 finding 3): if the runner
      // signaled cancellation while we were filling toolResults, refuse to
      // start a new side-effecting tool call.
      if (ctx.signal?.aborted) {
        throw new Error('aborted');
      }
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
        const result = await toolDispatcher(tu.tool, tu.args, {
          signal: ctx.signal,
          idempotency_key: `${idempotencyPrefix}:${tu.id}`,
        });
        toolCallCount++;
        toolsCalled.push(tu.tool);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const e = err as Error;
        // Propagate cancellation upward — never swallow an abort into the
        // tool-result stream as a normal error (review #99 finding 3).
        if (e.message === 'aborted' || ctx.signal?.aborted) {
          throw new Error('aborted', { cause: err });
        }
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

  // Loop exited via break (token budget) or natural end — return what we have.
  if (tokenBudgetExceeded) {
    const parsed = safeParseJson(lastContent ?? '');
    return {
      ...parsed,
      _tools_called: toolsCalled,
      _tokens_in: totalIn,
      _tokens_out: totalOut,
      _token_budget_exceeded: true,
      _tool_cap_hit: toolCapHit,
    };
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
