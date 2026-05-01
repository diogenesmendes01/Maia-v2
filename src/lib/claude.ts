import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sleep } from '@/lib/utils.js';
import { recordLLMCost } from '@/lib/cost-ledger.js';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { getCurrentMainModel, getCurrentFastModel } from '@/lib/llm-settings.js';

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
  }): Promise<LLMResponse> {
    const model = params.model ?? config.CLAUDE_MODEL_MAIN;
    const start = Date.now();
    const res = await this.getClient().messages.create({
      model,
      max_tokens: params.max_tokens ?? 1024,
      temperature: params.temperature ?? 0.2,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools as Anthropic.Tool[] | undefined,
    });
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

export function toOpenAITools(tools: ToolSchema[] | undefined): OAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export function fromOpenAIResponse(res: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
  const choice = res.choices[0];
  const msg = choice?.message;
  const tool_uses: LLMResponse['tool_uses'] = (msg?.tool_calls ?? []).map((tc) => {
    const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
    let args: unknown = {};
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
  }): Promise<LLMResponse> {
    const model = params.model ?? config.OPENROUTER_MODEL_MAIN;
    const start = Date.now();
    const res = await this.getClient().chat.completions.create({
      model,
      messages: toOpenAIMessages(params.system, params.messages),
      tools: toOpenAITools(params.tools),
      max_tokens: params.max_tokens ?? 1024,
      temperature: params.temperature ?? 0.2,
    });
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
}): Promise<LLMResponse> {
  // Read current model selection from facts (operator-changeable via dashboard).
  // Falls back to env defaults on miss or DB hiccup.
  const mainModel = await getCurrentMainModel();
  const fastModel = await getCurrentFastModel();

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < config.CLAUDE_MAX_RETRIES; attempt++) {
    try {
      return await provider.call({ ...params, model: mainModel });
    } catch (err) {
      lastErr = err;
      logger.warn({ attempt, err: (err as Error).message, model: mainModel }, 'llm.retry');
      if (attempt < config.CLAUDE_MAX_RETRIES - 1) {
        await sleep(2000 * Math.pow(2, attempt));
      }
    }
  }
  // fallback to fast model
  try {
    logger.warn({ fallback_model: fastModel }, 'llm.fallback_to_fast');
    return await provider.call({ ...params, model: fastModel });
  } catch (err) {
    logger.error({ err }, 'llm.fast_fallback_failed');
    throw lastErr ?? err;
  }
}
