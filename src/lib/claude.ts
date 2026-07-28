/**
 * Facade de compatibilidade sobre o LLM Gateway (issue #508).
 *
 * Este arquivo era a abstração de LLM da plataforma: continha os adapters
 * Anthropic/OpenRouter, escolhia o provider uma vez no carregamento do módulo,
 * lia main e fast em duas operações sequenciais por chamada e implementava
 * retry/fallback à mão sem deadline compartilhado. Todo esse comportamento
 * migrou para `src/lib/llm/**`:
 *
 *   src/lib/llm/gateway.ts         → deadline, cancelamento, retry, fallback
 *   src/lib/llm/model-resolver.ts  → provider/modelo por tier, com cache
 *   src/lib/llm/providers/**       → os ÚNICOS imports de SDK autorizados
 *   src/lib/llm/telemetry.ts       → métrica, custo e evento de uso
 *
 * O que sobra aqui:
 *  - Re-exports de tipos e dos conversores OpenRouter, para não quebrar os
 *    imports existentes (`@/lib/claude.js`) nem os testes que cobrem os
 *    conversores diretamente.
 *  - `callLLM()`, agora um adapter fino que delega ao gateway. Ele aceita
 *    `workload` e `tier` explícitos: é assim que os call sites declaram
 *    intenção sem que cada teste que hoje mocka `callLLM` precise ser
 *    reescrito. Novos call sites devem preferir `executeLLM` de
 *    `@/lib/llm/index.js`.
 */
import { executeLLM } from '@/lib/llm/gateway.js';
import type {
  LLMExecutionContext,
  LLMMessage,
  LLMResponse,
  LLMTier,
  LLMWorkload,
  ToolSchema,
} from '@/lib/llm/types.js';

export type {
  LLMContentBlock,
  LLMExecutionContext,
  LLMImageMediaType,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTier,
  LLMUsage,
  LLMWorkload,
  ToolSchema,
} from '@/lib/llm/types.js';

export {
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIResponse,
} from '@/lib/llm/providers/openrouter.js';

/**
 * @deprecated Prefira `executeLLM` (`@/lib/llm/index.js`) em código novo.
 * Mantido enquanto houver call sites (e testes) que dependem deste símbolo.
 */
export async function callLLM(params: {
  system: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  /**
   * Atribuição de custo por pessoa. Workers fora de contexto de pessoa
   * (briefings, batches de reflexão) deixam undefined → só o agregado global
   * se move.
   */
  pessoa_id?: string;
  /**
   * Cancelamento do caller, propagado até a requisição HTTP do SDK
   * (issue #220) e agora também até o backoff e o fallback (issue #508).
   */
  signal?: AbortSignal;
  /**
   * Intenção da chamada. Omitir mantém o comportamento legado sob o rótulo
   * `legacy`, que existe justamente para o resíduo de migração ficar visível
   * nas métricas.
   */
  workload?: LLMWorkload;
  /** Classe de modelo. Omitir usa o tier default do workload. */
  tier?: LLMTier;
  /** Deadline/trace opcionais (issues #507 e #514). */
  ctx?: LLMExecutionContext;
}): Promise<LLMResponse> {
  return executeLLM({
    workload: params.workload ?? 'legacy',
    tier: params.tier,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    pessoa_id: params.pessoa_id,
    ctx: {
      ...params.ctx,
      signal: params.ctx?.signal ?? params.signal,
    },
  });
}
