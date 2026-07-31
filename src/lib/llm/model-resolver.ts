/**
 * Resolução backend-side de provider + modelo por tier (issue #508).
 *
 * O que esta camada conserta em relação ao `src/lib/claude.ts` pré-#508:
 *
 *  1. **Uma leitura conjunta.** Antes, cada `callLLM()` fazia DUAS operações
 *     sequenciais (`getCurrentMainModel()` + `getCurrentFastModel()`), a cada
 *     iteração do ReAct. Agora main e fast saem de uma única chamada a
 *     `getCurrentLLMSettings()` (que já resolve as duas keys em paralelo) e
 *     ficam num cache de TTL curto.
 *  2. **Cache escopado por `tenant_id + agent_id`.** As settings são
 *     process-wide por design (issue #183), mas a chave do cache carrega o
 *     escopo mesmo assim: é a diferença entre "não vaza porque a fonte é
 *     global" e "não vaza por construção". Se a fonte virar per-tenant, este
 *     cache não precisa mudar. Contexto ausente cai numa chave `__unscoped__`
 *     separada — nunca no literal `'default'`.
 *  3. **TTL curto + TTL de falha.** Redis/DB indisponível não pode congelar um
 *     modelo antigo indefinidamente (critério explícito da issue). Falha de
 *     leitura cacheia o fallback de env por poucos segundos, para não
 *     martelar o banco a cada chamada, e expira sozinha.
 *
 * Invalidação distribuída (Admin muda o modelo → todas as réplicas soltam o
 * cache) é publicada por `src/lib/llm/cache-invalidation.ts`.
 */
import { getCurrentLLMSettings } from '@/lib/llm-settings.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { incCounter } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import { getProvider } from './providers/index.js';
import type { LLMTier, ResolvedModel } from './types.js';

/**
 * TTL do cache de settings. Curto de propósito: o custo de errar para cima
 * (modelo velho servindo tráfego durante um incidente) é maior que o de uma
 * leitura extra em `global_settings`.
 */
const CACHE_TTL_MS = 30_000;

/** TTL menor quando a leitura falhou e servimos o default de env. */
const FAILURE_TTL_MS = 5_000;

const UNSCOPED_KEY = '__unscoped__';

type CacheEntry = {
  main: string;
  fast: string;
  expires_at: number;
  degraded: boolean;
};

const cache = new Map<string, CacheEntry>();

/**
 * Chave de cache escopada. Serializada como JSON array em vez de concatenação
 * com separador: qualquer separador escolhido à mão pode, em tese, aparecer
 * dentro de um id e fazer duas tuplas distintas colidirem na mesma entrada —
 * que é exatamente a classe de bug que o invariante de isolamento existe para
 * impedir.
 */
function scopeKey(): string {
  const ctx = tryGetCurrentContext();
  if (!ctx) return UNSCOPED_KEY;
  return JSON.stringify([ctx.tenant_id, ctx.agent_id]);
}

async function loadSettings(key: string): Promise<CacheEntry> {
  const provider = getProvider();
  try {
    // UMA operação: getCurrentLLMSettings resolve main + fast em paralelo.
    const settings = await getCurrentLLMSettings();
    incCounter('maia_llm_settings_cache_total', { result: 'miss' });
    return {
      main: settings.main.value,
      fast: settings.fast.value,
      expires_at: Date.now() + CACHE_TTL_MS,
      degraded: false,
    };
  } catch (err) {
    // Fail-safe (não fail-closed): sem modelo não há chamada nenhuma, e
    // recusar todo tráfego por um hiccup de banco é pior que servir o default
    // de env. O TTL curto garante que a degradação não persiste.
    incCounter('maia_llm_settings_cache_total', { result: 'error' });
    logger.warn(
      { err: (err as Error).message, scope: key === UNSCOPED_KEY ? 'unscoped' : 'scoped' },
      'llm_gateway.settings_read_failed',
    );
    return {
      main: provider.envDefault('main'),
      fast: provider.envDefault('fast'),
      expires_at: Date.now() + FAILURE_TTL_MS,
      degraded: true,
    };
  }
}

/**
 * Resolve main + fast do escopo atual, com cache. Chamadas concorrentes no
 * mesmo escopo podem disparar mais de uma leitura na primeira vez — aceitável
 * (a leitura é idempotente e barata) e mais simples que um single-flight que
 * precisaria ser invalidado junto com o cache.
 */
async function getScopedModels(): Promise<{ main: string; fast: string }> {
  const key = scopeKey();
  const hit = cache.get(key);
  if (hit && hit.expires_at > Date.now()) {
    incCounter('maia_llm_settings_cache_total', { result: 'hit' });
    return { main: hit.main, fast: hit.fast };
  }
  const entry = await loadSettings(key);
  cache.set(key, entry);
  return { main: entry.main, fast: entry.fast };
}

/**
 * Resolve provider + slug para o tier pedido.
 *
 * `vision` compartilha o slug de `fast` hoje (é o que `src/lib/vision.ts`
 * usava: `config.CLAUDE_MODEL_FAST`). Existe como tier próprio para que trocar
 * o modelo de visão não force mexer nos classificadores — e para que a
 * métrica distinga os dois tráfegos.
 */
export async function resolveModel(tier: LLMTier): Promise<ResolvedModel> {
  const provider = getProvider();
  const { main, fast } = await getScopedModels();
  const model = tier === 'main' ? main : fast;
  return { provider: provider.name, model, tier };
}

/**
 * Resolve primário e fast juntos — o gateway já sai com o modelo de fallback
 * em mãos, sem uma segunda leitura no meio do retry.
 */
export async function resolveModelPair(
  tier: LLMTier,
): Promise<{ primary: ResolvedModel; fast: ResolvedModel }> {
  const provider = getProvider();
  const { main, fast } = await getScopedModels();
  const primaryModel = tier === 'main' ? main : fast;
  return {
    primary: { provider: provider.name, model: primaryModel, tier },
    fast: { provider: provider.name, model: fast, tier: 'fast' },
  };
}

/**
 * Invalida o cache. Sem argumento limpa tudo (é o que o handler de pub/sub
 * faz: a mudança no Admin é process-wide, então não há como invalidar só um
 * escopo com precisão).
 */
export function invalidateModelCache(scope?: { tenant_id: string; agent_id: string }): void {
  if (!scope) {
    cache.clear();
    incCounter('maia_llm_settings_cache_total', { result: 'invalidated' });
    return;
  }
  cache.delete(JSON.stringify([scope.tenant_id, scope.agent_id]));
  incCounter('maia_llm_settings_cache_total', { result: 'invalidated' });
}

export const _internal = { CACHE_TTL_MS, FAILURE_TTL_MS, UNSCOPED_KEY, scopeKey, cache };
