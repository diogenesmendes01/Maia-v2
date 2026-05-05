import { getToolCallingModels } from './openrouter-models.js';
import { logger } from '@/lib/logger.js';

/**
 * USD cents per 1k tokens. Same unit as the legacy hardcoded
 * `USD_CENTS_PER_1K_TOKENS` map in `cost-ledger.ts`, so the cost ledger
 * can interpolate dynamic and static rates without unit conversion.
 *
 * OpenRouter exposes prices as USD per 1M tokens. To go from there to
 * cents per 1k tokens: `(usd / 1_000_000) * 100 * 1_000` = `usd / 10`.
 */
export type Pricing = { input: number; output: number };

/**
 * Looks up a model's per-1k-token price from the OpenRouter cache.
 * Returns null when the slug is not found in the live (or cached/fallback)
 * model list, so callers can fall back to a hardcoded default.
 *
 * Uses the existing 1h cache in `openrouter-models.ts`, so the hot path
 * for `recordLLMCost` is in-memory after the first call.
 */
export async function getModelPricing(slug: string): Promise<Pricing | null> {
  try {
    const models = await getToolCallingModels();
    const m = models.find((x) => x.id === slug);
    if (!m) return null;
    return {
      input: m.pricing.prompt_per_million / 10,
      output: m.pricing.completion_per_million / 10,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, slug },
      'openrouter_pricing.lookup_failed',
    );
    return null;
  }
}
