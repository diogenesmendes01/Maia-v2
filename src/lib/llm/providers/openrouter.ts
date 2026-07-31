/**
 * Adapter OpenRouter — usa o SDK da OpenAI com `baseURL` custom. Um dos DOIS
 * únicos arquivos autorizados a importar SDK de provider (ver
 * `no-restricted-imports` em `eslint.config.js`).
 *
 * Conversão de formato: mensagens estilo Anthropic ⇄ OpenAI Chat Completions.
 * Os três conversores continuam exportados (e re-exportados por
 * `src/lib/claude.ts`) porque `tests/unit/openrouter-converters.spec.ts`
 * cobre o contrato deles diretamente.
 */
import OpenAI from 'openai';
import { config } from '@/config/env.js';
import {
  describeProviderPayload,
  recordProviderPayload,
  recordStrictDowngrade,
  supportsStrictToolSchemas,
  toStrictJsonSchema,
} from '@/lib/tool-schema-provider.js';
import { LLMGatewayError } from '../errors.js';
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTier,
  ToolSchema,
} from '../types.js';

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
      // user role: tool_results viram role='tool'; texto puro segue role='user'.
      const tool_results = m.content.filter(
        (b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
          b.type === 'tool_result',
      );
      const text = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // Visão (issue #508): blocos de imagem viram `image_url` com data URI.
      // A Anthropic recebe base64 estruturado; a OpenAI só aceita URL, então a
      // conversão é feita aqui e não no caller — é o que permite o mesmo
      // `LLMMessage` servir os dois providers.
      const images = m.content.filter(
        (b): b is Extract<LLMContentBlock, { type: 'image' }> => b.type === 'image',
      );
      for (const tr of tool_results) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content } as OAIMessage);
      }
      if (images.length > 0) {
        const parts: Array<Record<string, unknown>> = images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
        }));
        if (text) parts.push({ type: 'text', text });
        out.push({ role: 'user', content: parts } as unknown as OAIMessage);
      } else if (text) {
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

/**
 * Issue #509 — quando o modelo está na matriz de capacidade strict, o schema
 * canônico é reescrito para o subconjunto estrito e `function.strict` é
 * anexado. Recusa e motivo são contabilizados em vez de silenciados: uma tool
 * cujo contrato não cabe no subconjunto é entregue sem strict, nunca com um
 * contrato que o Zod do dispatcher rejeitaria.
 *
 * `model` é opcional para os call sites que só querem o envelope OpenAI
 * (os conversores são testados diretamente em `openrouter-converters.spec.ts`).
 */
export function toOpenAITools(
  tools: ToolSchema[] | undefined,
  model?: string,
): OAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const strictCapable = supportsStrictToolSchemas('openrouter', model);
  return tools.map((t) => {
    const fn: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    } = {
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
  const choice = res.choices?.[0];
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

export class OpenRouterProvider implements LLMProvider {
  name = 'openrouter' as const;
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return Boolean(config.OPENROUTER_API_KEY);
  }

  envDefault(tier: LLMTier): string {
    return tier === 'main' ? config.OPENROUTER_MODEL_MAIN : config.OPENROUTER_MODEL_FAST;
  }

  private getClient(): OpenAI {
    if (this.client) return this.client;
    if (!config.OPENROUTER_API_KEY) {
      throw new LLMGatewayError({
        kind: 'configuration',
        detail: 'OPENROUTER_API_KEY required when LLM_PROVIDER=openrouter',
        provider: 'openrouter',
      });
    }
    this.client = new OpenAI({
      apiKey: config.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      // Camada única de retry: o gateway manda, o SDK obedece (issue #508).
      maxRetries: 0,
      defaultHeaders: {
        // Recomendado pela OpenRouter para ranking na leaderboard deles.
        // X-OpenRouter-Title é o nome canônico (2026); X-Title ainda é aceito.
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
    model: string;
    signal?: AbortSignal;
    timeout_ms?: number;
  }): Promise<LLMResponse> {
    const requestOptions: Record<string, unknown> = { maxRetries: 0 };
    if (params.signal) requestOptions.signal = params.signal;
    if (params.timeout_ms !== undefined) requestOptions.timeout = params.timeout_ms;

    // Issue #509 — o modelo decide se `function.strict` é anexado.
    const oaiTools = toOpenAITools(params.tools, params.model);
    // PR #530 P2 — o envelope strict REESCREVE o schema (required, keywords
    // removidas, descrições), então o hash canônico auditado pelo runtime
    // filter não identifica este payload. Os dois hashes são calculados sobre
    // a MESMA projeção ({name → hash do schema}), para `rewritten` ser uma
    // resposta de verdade e não a comparação de dois domínios diferentes.
    if (params.tools && params.tools.length > 0 && oaiTools) {
      const fnOf = (t: OAITool) =>
        (
          t as {
            function?: { name?: string; parameters?: Record<string, unknown>; strict?: boolean };
          }
        ).function;
      recordProviderPayload(
        describeProviderPayload({
          provider: 'openrouter',
          model: params.model,
          canonical: params.tools,
          effective: oaiTools.map((t) => ({
            name: fnOf(t)?.name ?? '',
            schema: fnOf(t)?.parameters ?? {},
          })),
          payload: oaiTools,
          strictCount: oaiTools.filter((t) => fnOf(t)?.strict === true).length,
        }),
      );
    }

    const res = await this.getClient().chat.completions.create(
      {
        model: params.model,
        messages: toOpenAIMessages(params.system, params.messages),
        tools: oaiTools,
        max_tokens: params.max_tokens ?? 1024,
        temperature: params.temperature ?? 0.2,
      },
      requestOptions,
    );
    // Um 200 com `choices: []` (OpenRouter devolve isso quando o modelo
    // upstream falha) virava `content: null` + `stop_reason: 'error'` e o
    // gateway registrava `status='ok'`. A taxonomia tinha `response_invalid`
    // desde o começo e nunca era usada — este é o ponto onde ela vale.
    const choice = res?.choices?.[0];
    if (!choice || !choice.message) {
      throw new LLMGatewayError({
        kind: 'response_invalid',
        detail: 'openrouter response has no usable choice',
        provider: this.name,
        model: params.model,
      });
    }

    const out = fromOpenAIResponse(res);
    if (out.stop_reason === 'error') {
      throw new LLMGatewayError({
        kind: 'response_invalid',
        detail: 'openrouter response has an unmapped finish_reason',
        provider: this.name,
        model: params.model,
      });
    }
    // O slug efetivo é o que pedimos: a OpenRouter às vezes ecoa uma variante
    // roteada e a métrica precisa bater com o modelo que o backend escolheu.
    return { ...out, model: out.model || params.model };
  }
}
