/**
 * Seleção de provider (issue #508).
 *
 * Mudança em relação ao `src/lib/claude.ts` pré-#508: a seleção NÃO acontece
 * mais uma vez no carregamento do módulo. Um `LLM_PROVIDER` trocado depois do
 * import (rollback de incidente, teste que remocka a config) passava
 * despercebido porque o `const provider = selectProvider()` já tinha
 * congelado a escolha. Agora resolvemos por chamada e memoizamos a INSTÂNCIA
 * por nome — o cliente HTTP continua sendo criado uma vez só.
 */
import { config } from '@/config/env.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenRouterProvider } from './openrouter.js';
import type { LLMProvider, LLMProviderName } from '../types.js';

const instances = new Map<LLMProviderName, LLMProvider>();

export function getProvider(name?: LLMProviderName): LLMProvider {
  // O enum do env já é restrito aos dois casos; qualquer outro valor cai em
  // anthropic (operadores que querem GPT/Llama/Gemini passam por OpenRouter).
  const resolved: LLMProviderName = name ?? (config.LLM_PROVIDER === 'openrouter' ? 'openrouter' : 'anthropic');
  const cached = instances.get(resolved);
  if (cached) return cached;
  const created: LLMProvider =
    resolved === 'openrouter' ? new OpenRouterProvider() : new AnthropicProvider();
  instances.set(resolved, created);
  return created;
}

/**
 * Fail-closed de configuração: o provider ATIVO tem chave? Substitui os
 * `process.env.ANTHROPIC_API_KEY ?? ''` espalhados pela cognição, que
 * exigiam a chave da Anthropic mesmo com `LLM_PROVIDER=openrouter`.
 */
export function isLLMConfigured(): boolean {
  return getProvider().isConfigured();
}

/** Test seam: força a recriação das instâncias (usado após remockar config). */
export function _resetProvidersForTests(): void {
  instances.clear();
}

/**
 * Test/benchmark seam: injeta uma instância no lugar do adapter real.
 *
 * Existe para o harness de carga (`scripts/llm-benchmark.ts`, issue #534)
 * poder exercitar o gateway INTEIRO — deadline, retry, fallback, disjuntor,
 * telemetria — contra um provider sintético, sem rede e sem custo. Sem este
 * seam, medir o gateway exigiria ou gastar dinheiro real ou testar outra coisa
 * que não o gateway.
 *
 * NÃO é caminho de produção: nada em `src/` chama esta função, o nome carrega
 * o prefixo `_` da convenção de seams do repositório, e ela não é reexportada
 * por `src/lib/llm/index.js`, que é a superfície pública do gateway.
 */
export function _injectProviderForTests(name: LLMProviderName, provider: LLMProvider): void {
  instances.set(name, provider);
}

export { AnthropicProvider } from './anthropic.js';
export {
  OpenRouterProvider,
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIResponse,
} from './openrouter.js';
