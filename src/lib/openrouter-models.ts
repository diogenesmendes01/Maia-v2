import { logger } from '@/lib/logger.js';

/**
 * Live list of OpenRouter models filtered to those that support tool calling
 * (the Maia agent loop requires it). Fetched from the public
 * `https://openrouter.ai/api/v1/models` endpoint (no auth needed) and cached
 * in-memory for 1 hour.
 *
 * On network error or first-call cache miss with a network failure, we fall
 * back to a curated hardcoded list of well-known tool-calling models so the
 * dashboard stays usable even if OpenRouter is unreachable.
 */
export type OpenRouterModel = {
  id: string; // slug like 'anthropic/claude-sonnet-4.6'
  name: string; // human-readable like 'Anthropic: Claude Sonnet 4.6'
  context_length: number;
  pricing: {
    prompt_per_million: number; // USD per 1M input tokens
    completion_per_million: number; // USD per 1M output tokens
  };
  supports_tools: boolean;
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache: { fetched_at: number; models: OpenRouterModel[] } | null = null;

const FALLBACK_TOOL_MODELS: OpenRouterModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Anthropic: Claude Sonnet 4.6 (recomendado)',
    context_length: 200000,
    pricing: { prompt_per_million: 3, completion_per_million: 15 },
    supports_tools: true,
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Anthropic: Claude Haiku 4.5 (fast)',
    context_length: 200000,
    pricing: { prompt_per_million: 0.8, completion_per_million: 4 },
    supports_tools: true,
  },
  {
    id: 'anthropic/claude-sonnet-latest',
    name: 'Anthropic: Claude Sonnet (latest auto-update)',
    context_length: 200000,
    pricing: { prompt_per_million: 3, completion_per_million: 15 },
    supports_tools: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'OpenAI: GPT-5',
    context_length: 200000,
    pricing: { prompt_per_million: 5, completion_per_million: 15 },
    supports_tools: true,
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Google: Gemini 2.5 Pro',
    context_length: 1000000,
    pricing: { prompt_per_million: 1.25, completion_per_million: 5 },
    supports_tools: true,
  },
  {
    id: 'x-ai/grok-4.1-fast',
    name: 'xAI: Grok 4.1 Fast (barato + tool-use)',
    context_length: 256000,
    pricing: { prompt_per_million: 0.2, completion_per_million: 0.5 },
    supports_tools: true,
  },
];

type RawPricing = { prompt?: string; completion?: string };
type RawModel = {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: RawPricing;
  supported_parameters?: string[];
};

function parseRawModel(raw: RawModel): OpenRouterModel | null {
  if (!raw.id || typeof raw.id !== 'string') return null;
  const supports_tools = Array.isArray(raw.supported_parameters)
    && raw.supported_parameters.includes('tools');
  if (!supports_tools) return null;
  // Pricing in OpenRouter /models is per-token (e.g. '0.00000125' = $1.25/M).
  const promptPerToken = parseFloat(raw.pricing?.prompt ?? '0');
  const completionPerToken = parseFloat(raw.pricing?.completion ?? '0');
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    context_length: typeof raw.context_length === 'number' ? raw.context_length : 0,
    pricing: {
      prompt_per_million: Math.round(promptPerToken * 1_000_000 * 1000) / 1000,
      completion_per_million: Math.round(completionPerToken * 1_000_000 * 1000) / 1000,
    },
    supports_tools: true,
  };
}

/** 5 s timeout: long enough for an honest-slow response, short enough
 * that a hung connection does not block the dashboard cold-render. On
 * timeout the AbortError reaches the caller and triggers the fallback. */
const FETCH_TIMEOUT_MS = 5000;

async function fetchFresh(): Promise<OpenRouterModel[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // No body, no auth — this endpoint is public.
  });
  if (!res.ok) {
    throw new Error(`openrouter /models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: RawModel[] };
  if (!Array.isArray(json.data)) {
    throw new Error('openrouter /models response missing data array');
  }
  return json.data
    .map(parseRawModel)
    .filter((m): m is OpenRouterModel => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * Returns the list of tool-calling-capable models. Caches for 1 h. On error,
 * returns the previously-cached value if any, else the hardcoded fallback.
 */
export async function getToolCallingModels(): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.fetched_at < CACHE_TTL_MS) {
    return cache.models;
  }
  try {
    const fresh = await fetchFresh();
    cache = { fetched_at: Date.now(), models: fresh };
    logger.debug({ count: fresh.length }, 'openrouter_models.refreshed');
    return fresh;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, has_stale_cache: cache !== null },
      'openrouter_models.fetch_failed_using_fallback',
    );
    if (cache) return cache.models; // serve stale rather than no list at all
    return FALLBACK_TOOL_MODELS;
  }
}

/** Test-only seam: clears the in-memory cache so each test starts fresh. */
export const _internal = {
  resetCache: () => {
    cache = null;
  },
  getCache: () => cache,
  FALLBACK_TOOL_MODELS,
};
