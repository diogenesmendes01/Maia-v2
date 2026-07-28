/**
 * Superfície pública do LLM Gateway (issue #508).
 *
 * Importe daqui (`@/lib/llm/index.js`) — não dos submódulos — em qualquer
 * módulo de cognição, agente, skill ou worker. Os adapters de provider são
 * detalhe interno e estão atrás de uma regra de lint.
 */
export { executeLLM } from './gateway.js';
export { isLLMConfigured, getProvider } from './providers/index.js';
export { invalidateModelCache, resolveModel, resolveModelPair } from './model-resolver.js';
export { workloadPolicy } from './workloads.js';
export {
  LLMGatewayError,
  classifyProviderError,
  isAbortError,
  isRetryableKind,
  parseRetryAfterMs,
  redactErrorText,
} from './errors.js';
export type { LLMErrorKind } from './errors.js';
export type {
  LLMContentBlock,
  LLMExecutionContext,
  LLMGatewayRequest,
  LLMImageMediaType,
  LLMMessage,
  LLMProvider,
  LLMProviderName,
  LLMResponse,
  LLMTier,
  LLMUsage,
  LLMWorkload,
  ResolvedModel,
  ToolSchema,
} from './types.js';
