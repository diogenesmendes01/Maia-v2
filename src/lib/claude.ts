import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { recordLLMCost } from '@/lib/cost-ledger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { getCurrentMainModel, getCurrentFastModel } from '@/lib/llm-settings.js';
// Issue #509 §3 — provider capability matrix + strict-mode adaptation of the
// canonical tool schemas. Decided by the backend, never by the model.
import {
  supportsStrictToolSchemas,
  toStrictJsonSchema,
  recordStrictDowngrade,
} from '@/lib/tool-schema-provider.js';

export type LLMMessage = {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      >;
};

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type LLMUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read?: number;
  cache_write?: number;
};

export type LLMResponse = {
  content: string | null;
  tool_uses: Array<{ id: string; tool: string; args: unknown }>;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage: LLMUsage;
  model: string;
};

export interface LLMProvider {
  name: 'anthropic' | 'openrouter';
  call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model?: string;
    /**
     * Optional AbortSignal forwarded to the underlying SDK request. When the
     * signal aborts (e.g. SkillRunner timeout fires), the in-flight HTTP call
     * is cancelled rather than left running to completion. Issue #220.
     */
    signal?: AbortSignal;
  }): Promise<LLMResponse>;
}

// ============================================================
// Anthropic provider (legacy default)
// ============================================================
class AnthropicProvider implements LLMProvider {
  name = 'anthropic' as const;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (this.client) return this.client;
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic');
    }
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return this.client;
  }

  async call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model?: string;
    pessoa_id?: string;
    signal?: AbortSignal;
  }): Promise<LLMResponse> {
    const model = params.model ?? config.CLAUDE_MODEL_MAIN;
    const start = Date.now();
    const res = await this.getClient().messages.create(
      {
        model,
        max_tokens: params.max_tokens ?? 1024,
        temperature: params.temperature ?? 0.2,
        system: params.system,
        messages: params.messages as Anthropic.MessageParam[],
        tools: params.tools as Anthropic.Tool[] | undefined,
      },
      // signal: forwarded so callers (e.g. SkillRunner) can cancel the
      // in-flight HTTP request when their timeout fires. Issue #220.
      params.signal ? { signal: params.signal } : undefined,
    );
    const tool_uses: LLMResponse['tool_uses'] = [];
    let textOut: string | null = null;
    for (const block of res.content) {
      if (block.type === 'text') textOut = (textOut ?? '') + block.text;
      else if (block.type === 'tool_use')
        tool_uses.push({ id: block.id, tool: block.name, args: block.input });
    }
    incCounter('maia_llm_calls_total', { provider: 'anthropic', model, status: 'ok' });
    incCounter('maia_llm_tokens_total', { provider: 'anthropic', model, kind: 'input' }, res.usage.input_tokens);
    incCounter('maia_llm_tokens_total', { provider: 'anthropic', model, kind: 'output' }, res.usage.output_tokens);
    observeHistogram('maia_llm_latency_ms', Date.now() - start, { provider: 'anthropic', model });
    await recordLLMCost({
      provider: 'anthropic',
      model,
      tokens_input: res.usage.input_tokens,
      tokens_output: res.usage.output_tokens,
      pessoa_id: params.pessoa_id,
    }).catch(() => undefined);
    return {
      content: textOut,
      tool_uses,
      stop_reason: res.stop_reason as LLMResponse['stop_reason'],
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
      model,
    };
  }
}

// ============================================================
// OpenRouter provider (uses OpenAI SDK with custom baseURL)
// Format conversion: Anthropic-style messages <-> OpenAI Chat Completions.
// ============================================================
type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OAITool = OpenAI.Chat.Completions.ChatCompletionTool;

export function toOpenAIMessages(system: string, messages: LLMMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OAIMessage);
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const tool_calls = m.content
        .filter(
          (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
            b.type === 'tool_use',
        )
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const msg: OAIMessage = { role: 'assistant', content: text || null } as OAIMessage;
      if (tool_calls.length > 0) {
        (msg as { tool_calls?: typeof tool_calls }).tool_calls = tool_calls;
      }
      out.push(msg);
    } else {
      // user role: tool_results become role='tool' messages, plain text stays role='user'
      const tool_results = m.content.filter(
        (b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
          b.type === 'tool_result',
      );
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (const tr of tool_results) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content } as OAIMessage);
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/**
 * Map canonical tool schemas (issue #509) onto the OpenAI function shape.
 *
 * When `model` is given AND the backend capability matrix says that model
 * supports strict function calling, each schema is rewritten into the
 * strict-mode subset and shipped with `strict: true` — but ONLY when that
 * rewrite is FAITHFUL to the Zod contract. A schema that cannot be expressed
 * faithfully (union root, dynamic map, untyped value, or an `.optional()` field
 * that is not `.nullable()`) is sent AS IS without `strict` and the downgrade is
 * counted with its reason. The model is then less constrained while generating,
 * but nothing about enforcement changes: Zod revalidates every call in
 * `_dispatcher.ts` and every gate still runs.
 *
 * `model` is optional so existing callers keep the previous behaviour exactly.
 */
export function toOpenAITools(
  tools: ToolSchema[] | undefined,
  model?: string,
): OAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const strictCapable = supportsStrictToolSchemas('openrouter', model);
  return tools.map((t) => {
    const fn: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean } = {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    };
    if (model !== undefined) {
      if (!strictCapable) {
        recordStrictDowngrade('openrouter', model, 'model_not_strict_capable');
      } else {
        const strict = toStrictJsonSchema(t.input_schema);
        if (strict.ok) {
          fn.parameters = strict.schema;
          fn.strict = true;
        } else {
          recordStrictDowngrade('openrouter', model, strict.reason);
        }
      }
    }
    return { type: 'function', function: fn } as OAITool;
  });
}

export function fromOpenAIResponse(res: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
  const choice = res.choices[0];
  const msg = choice?.message;
  const tool_uses: LLMResponse['tool_uses'] = (msg?.tool_calls ?? []).map((tc) => {
    const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
    let args: unknown;
    try {
      args = JSON.parse(fn?.arguments ?? '{}');
    } catch {
      args = { _raw: fn?.arguments ?? '' };
    }
    return { id: tc.id, tool: fn?.name ?? '', args };
  });
  let stop_reason: LLMResponse['stop_reason'] = 'error';
  if (choice?.finish_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (choice?.finish_reason === 'stop') stop_reason = 'end_turn';
  else if (choice?.finish_reason === 'length') stop_reason = 'max_tokens';
  return {
    content: msg?.content ?? null,
    tool_uses,
    stop_reason,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
    model: res.model,
  };
}

class OpenRouterProvider implements LLMProvider {
  name = 'openrouter' as const;
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (this.client) return this.client;
    if (!config.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY required when LLM_PROVIDER=openrouter');
    }
    this.client = new OpenAI({
      apiKey: config.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // Recommended by OpenRouter for app ranking on their leaderboard.
        // X-OpenRouter-Title is the canonical name (2026); X-Title is still
        // accepted for backwards compat per their docs.
        'HTTP-Referer': 'https://github.com/diogenesmendes01/Maia-v2',
        'X-OpenRouter-Title': 'Maia',
      },
    });
    return this.client;
  }

  async call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model?: string;
    pessoa_id?: string;
    signal?: AbortSignal;
  }): Promise<LLMResponse> {
    const model = params.model ?? config.OPENROUTER_MODEL_MAIN;
    const start = Date.now();
    const res = await this.getClient().chat.completions.create(
      {
        model,
        messages: toOpenAIMessages(params.system, params.messages),
        // Issue #509 — pass the model so the strict-mode capability matrix can
        // decide whether `function.strict` is attached for this request.
        tools: toOpenAITools(params.tools, model),
        max_tokens: params.max_tokens ?? 1024,
        temperature: params.temperature ?? 0.2,
      },
      // signal: forwarded so callers (e.g. SkillRunner) can cancel the
      // in-flight HTTP request when their timeout fires. Issue #220.
      params.signal ? { signal: params.signal } : undefined,
    );
    const out = fromOpenAIResponse(res);
    incCounter('maia_llm_calls_total', { provider: 'openrouter', model, status: 'ok' });
    incCounter('maia_llm_tokens_total', { provider: 'openrouter', model, kind: 'input' }, out.usage.input_tokens);
    incCounter('maia_llm_tokens_total', { provider: 'openrouter', model, kind: 'output' }, out.usage.output_tokens);
    observeHistogram('maia_llm_latency_ms', Date.now() - start, { provider: 'openrouter', model });
    await recordLLMCost({
      provider: 'openrouter',
      model,
      tokens_input: out.usage.input_tokens,
      tokens_output: out.usage.output_tokens,
      pessoa_id: params.pessoa_id,
    }).catch(() => undefined);
    return out;
  }
}

// ============================================================
// Provider selection at module load. The env enum is restricted to the
// two cases this switch handles ('anthropic' | 'openrouter'); operators
// wanting GPT, Llama, Gemini, DeepSeek etc. route through OpenRouter.
// ============================================================
function selectProvider(): LLMProvider {
  if (config.LLM_PROVIDER === 'openrouter') return new OpenRouterProvider();
  return new AnthropicProvider();
}

const provider: LLMProvider = selectProvider();

export async function callLLM(params: {
  system: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  /**
   * Optional. When set, the per-call cost is also aggregated into a per-pessoa
   * fact key so the dashboard can show a per-pessoa cost breakdown. Workers
   * outside any pessoa context (briefings, reflection batches) leave it
   * undefined → only the global counter moves.
   */
  pessoa_id?: string;
  /**
   * Optional AbortSignal forwarded to the underlying provider SDK. When the
   * signal aborts mid-call (e.g. SkillRunner timeout fires while a retry is
   * pending), the loop is short-circuited so we don't keep retrying a
   * cancelled request. Issue #220.
   */
  signal?: AbortSignal;
}): Promise<LLMResponse> {
  // Early cancellation — refuse to start any work (including the model
  // lookup) when the signal has already aborted. PR #221 review, item 4:
  // a caller that aborts before this entry point shouldn't pay for the
  // settings-fact read or any other setup.
  if (params.signal?.aborted) {
    throw new Error('llm_call_aborted', { cause: params.signal.reason });
  }

  // Read current model selection from facts (operator-changeable via dashboard).
  // Falls back to env defaults on miss or DB hiccup.
  const mainModel = await getCurrentMainModel();
  const fastModel = await getCurrentFastModel();

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < config.CLAUDE_MAX_RETRIES; attempt++) {
    // Honor caller cancellation before each attempt — refuse to start a new
    // request when the signal has already aborted. Issue #220.
    if (params.signal?.aborted) {
      throw new Error('llm_call_aborted', { cause: params.signal.reason });
    }
    try {
      return await provider.call({ ...params, model: mainModel });
    } catch (err) {
      lastErr = err;
      // Abort surfaced through the SDK — do not retry. Issue #220.
      if (params.signal?.aborted || isAbortError(err)) {
        throw err;
      }
      logger.warn({ attempt, err: (err as Error).message, model: mainModel }, 'llm.retry');
      if (attempt < config.CLAUDE_MAX_RETRIES - 1) {
        // Abort-aware backoff (PR #221 review, item 5): abort during the
        // retry sleep must short-circuit the timer instead of waiting it
        // out. Plain `await sleep(ms)` delays the abort by up to the
        // backoff duration.
        await abortableSleep(2000 * Math.pow(2, attempt), params.signal);
      }
    }
  }
  // fallback to fast model
  if (params.signal?.aborted) {
    throw lastErr ?? new Error('llm_call_aborted');
  }
  try {
    logger.warn({ fallback_model: fastModel }, 'llm.fallback_to_fast');
    return await provider.call({ ...params, model: fastModel });
  } catch (err) {
    // If the fallback request was aborted (caller cancelled mid-fallback),
    // surface the abort untouched. Throwing `lastErr ?? err` here would
    // mask the abort behind a prior main-model retry error and rob the
    // caller of the cancellation signal. PR #221 review, item 2.
    if (params.signal?.aborted || isAbortError(err)) {
      throw err;
    }
    logger.error({ err }, 'llm.fast_fallback_failed');
    throw lastErr ?? err;
  }
}

/**
 * Sleep for `ms` milliseconds, but reject immediately if `signal` aborts in
 * the meantime. Clears the timer on abort so the timeout doesn't stay
 * pending. Issue #220 / PR #221 review, item 5.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('llm_call_aborted', { cause: signal.reason }));
      return;
    }
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new Error('llm_call_aborted', { cause: signal.reason }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Detect SDK-thrown abort errors. Both Anthropic and OpenAI SDKs raise an
 * APIUserAbortError (`name === 'AbortError'`) when the request signal aborts;
 * a plain DOMException with name 'AbortError' is also possible from native
 * fetch. We check name to stay provider-agnostic. Issue #220.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}
