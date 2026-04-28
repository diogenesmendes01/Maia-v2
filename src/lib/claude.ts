import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sleep } from '@/lib/utils.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

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
  name: 'anthropic' | 'openai' | 'ollama';
  call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model?: string;
  }): Promise<LLMResponse>;
}

class AnthropicProvider implements LLMProvider {
  name = 'anthropic' as const;

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
    const res = await anthropic.messages.create({
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
    logger.debug(
      { model, ms: Date.now() - start, in: res.usage.input_tokens, out: res.usage.output_tokens },
      'llm.call',
    );
    return {
      content: textOut,
      tool_uses,
      stop_reason: res.stop_reason as LLMResponse['stop_reason'],
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
      model,
    };
  }
}

const provider: LLMProvider = new AnthropicProvider();

export async function callLLM(params: {
  system: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
}): Promise<LLMResponse> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < config.CLAUDE_MAX_RETRIES; attempt++) {
    try {
      return await provider.call({ ...params, model: config.CLAUDE_MODEL_MAIN });
    } catch (err) {
      lastErr = err;
      logger.warn({ attempt, err: (err as Error).message }, 'llm.retry');
      if (attempt < config.CLAUDE_MAX_RETRIES - 1) {
        await sleep(2000 * Math.pow(2, attempt));
      }
    }
  }
  // fallback to Haiku
  try {
    logger.warn('llm.fallback_to_haiku');
    return await provider.call({ ...params, model: config.CLAUDE_MODEL_FAST });
  } catch (err) {
    logger.error({ err }, 'llm.haiku_failed');
    throw lastErr ?? err;
  }
}
