/**
 * Adapter Anthropic — um dos DOIS únicos arquivos autorizados a importar
 * `@anthropic-ai/sdk` (o outro é `openrouter.ts`, para o SDK da OpenAI).
 * Ver a regra `no-restricted-imports` em `eslint.config.js`.
 *
 * Responsabilidade deste arquivo: traduzir o contrato provider-neutral para a
 * Messages API e de volta. NADA de métrica, custo, retry ou fallback aqui —
 * isso é do gateway. Antes da #508 os adapters registravam custo e counters,
 * o que deixava fora da contabilidade toda chamada que não passava por eles.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/config/env.js';
import { LLMGatewayError } from '../errors.js';
import type { LLMMessage, LLMProvider, LLMResponse, LLMTier, ToolSchema } from '../types.js';

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic' as const;
  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return Boolean(config.ANTHROPIC_API_KEY);
  }

  envDefault(tier: LLMTier): string {
    return tier === 'main' ? config.CLAUDE_MODEL_MAIN : config.CLAUDE_MODEL_FAST;
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    if (!config.ANTHROPIC_API_KEY) {
      throw new LLMGatewayError({
        kind: 'configuration',
        detail: 'ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic',
        provider: 'anthropic',
      });
    }
    this.client = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      // O gateway é a ÚNICA camada de retry (issue #508). Sem isto, o SDK
      // retenta 2x por conta própria dentro de CADA tentativa do gateway e a
      // contagem real de requisições vira 3x o que a métrica reporta.
      maxRetries: 0,
    });
    return this.client;
  }

  async call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    max_tokens?: number;
    model: string;
    signal?: AbortSignal;
    timeout_ms?: number;
  }): Promise<LLMResponse> {
    const requestOptions: Record<string, unknown> = { maxRetries: 0 };
    // `signal` é repassado por identidade quando o gateway não compôs nada em
    // cima dele, para que o cancelamento do caller chegue intacto ao HTTP.
    if (params.signal) requestOptions.signal = params.signal;
    if (params.timeout_ms !== undefined) requestOptions.timeout = params.timeout_ms;

    const res = await this.getClient().messages.create(
      {
        model: params.model,
        max_tokens: params.max_tokens ?? 1024,
        temperature: params.temperature ?? 0.2,
        system: params.system,
        messages: params.messages as unknown as Anthropic.MessageParam[],
        tools: params.tools as Anthropic.Tool[] | undefined,
      },
      requestOptions,
    );

    const tool_uses: LLMResponse['tool_uses'] = [];
    let textOut: string | null = null;
    for (const block of res.content ?? []) {
      if (block.type === 'text') textOut = (textOut ?? '') + block.text;
      else if (block.type === 'tool_use')
        tool_uses.push({ id: block.id, tool: block.name, args: block.input });
    }

    // `usage` é opcional defensivamente: um provider que responda sem o bloco
    // (ou um duplo de teste) não pode derrubar o turno com TypeError — o
    // resultado é contabilizado como 0 tokens e segue.
    return {
      content: textOut,
      tool_uses,
      stop_reason: normalizeStopReason(res.stop_reason, tool_uses.length > 0),
      usage: {
        input_tokens: res.usage?.input_tokens ?? 0,
        output_tokens: res.usage?.output_tokens ?? 0,
        cache_read: res.usage?.cache_read_input_tokens ?? undefined,
        cache_write: res.usage?.cache_creation_input_tokens ?? undefined,
      },
      model: params.model,
    };
  }
}

function normalizeStopReason(raw: unknown, hasToolUse: boolean): LLMResponse['stop_reason'] {
  if (raw === 'end_turn' || raw === 'tool_use' || raw === 'max_tokens') return raw;
  // Sem stop_reason explícito, inferimos do conteúdo em vez de marcar 'error':
  // um 'error' aqui faria o ReAct loop tratar uma resposta válida como falha.
  return hasToolUse ? 'tool_use' : 'end_turn';
}
