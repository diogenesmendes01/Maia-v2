import { factsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { getModelPricing, type Pricing } from '@/lib/openrouter-pricing.js';

// Approximate USD prices per 1k tokens (cents) for direct-Anthropic and other
// providers that don't ship through OpenRouter. Conservative on purpose so the
// daily-threshold alert fires earlier on miscount rather than later.
//
// For OpenRouter slugs (`vendor/model` format) we prefer the live pricing
// from the OpenRouter cache (see `getModelPricing`); these entries here are
// only the fallback when the slug is unknown or the lookup throws.
const USD_CENTS_PER_1K_TOKENS: Record<string, Pricing> = {
  'claude-sonnet-4-6': { input: 0.3, output: 1.5 },
  'claude-opus-4-7': { input: 1.5, output: 7.5 },
  'claude-haiku-4-5-20251001': { input: 0.08, output: 0.4 },
  'voyage-3': { input: 0.012, output: 0 },
  'whisper-1': { input: 0.6, output: 0 },
};

const DEFAULT_RATE: Pricing = { input: 0.3, output: 1.5 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolves the pricing for a given (provider, model) tuple:
 * 1. If the model id looks like an OpenRouter slug (`vendor/model`),
 *    consult the live OpenRouter pricing cache first.
 * 2. Fall back to the local hardcoded map.
 * 3. Final fallback: a generic "Sonnet-class" rate so misconfigured callers
 *    still emit *some* cost signal instead of 0.
 */
async function rateFor(_provider: string, model: string): Promise<Pricing> {
  if (model.includes('/')) {
    const dynamic = await getModelPricing(model);
    if (dynamic) return dynamic;
  }
  return USD_CENTS_PER_1K_TOKENS[model] ?? DEFAULT_RATE;
}

async function bumpFact(
  escopo: string,
  key: string,
  delta: { tokens_input: number; tokens_output: number; usd_cents: number; pessoa_id?: string },
  meta: { provider: string; last_model: string },
): Promise<void> {
  const existing = await factsRepo.getByKey(escopo, key);
  const prev = (existing?.valor ?? {}) as {
    tokens_input?: number;
    tokens_output?: number;
    usd_cents?: number;
  };
  await factsRepo.upsert({
    escopo,
    chave: key,
    valor: {
      tokens_input: (prev.tokens_input ?? 0) + delta.tokens_input,
      tokens_output: (prev.tokens_output ?? 0) + delta.tokens_output,
      usd_cents: Math.round(((prev.usd_cents ?? 0) + delta.usd_cents) * 100) / 100,
      provider: meta.provider,
      last_model: meta.last_model,
      ...(delta.pessoa_id ? { pessoa_id: delta.pessoa_id } : {}),
    },
    fonte: 'inferido',
    confianca: 1,
  });
}

export async function recordLLMCost(input: {
  provider: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  pessoa_id?: string;
}): Promise<void> {
  try {
    const day = todayKey();
    const rate = await rateFor(input.provider, input.model);
    const usd_cents =
      (input.tokens_input / 1000) * rate.input + (input.tokens_output / 1000) * rate.output;
    const meta = { provider: input.provider, last_model: input.model };

    // 1) Always write the global daily aggregate (back-compat with
    //    `cost-monitor.ts` and `readDailyLLMUsd`).
    await bumpFact(
      'global',
      `cost.daily.llm.${day}`,
      {
        tokens_input: input.tokens_input,
        tokens_output: input.tokens_output,
        usd_cents,
      },
      meta,
    );

    // 2) When called from a per-pessoa code path, also bump the per-pessoa
    //    bucket so the dashboard can show a breakdown. The chave is unique
    //    per pessoa so multiple pessoas on the same day don't collide on
    //    the (escopo, chave) unique index.
    if (input.pessoa_id) {
      await bumpFact(
        'pessoa',
        `cost.daily.llm.${day}.${input.pessoa_id}`,
        {
          tokens_input: input.tokens_input,
          tokens_output: input.tokens_output,
          usd_cents,
          pessoa_id: input.pessoa_id,
        },
        meta,
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cost_ledger.llm_failed');
  }
}

export async function readDailyLLMUsd(day: string = todayKey()): Promise<number> {
  const f = await factsRepo.getByKey('global', `cost.daily.llm.${day}`);
  if (!f) return 0;
  const v = (f.valor ?? {}) as { usd_cents?: number };
  return (v.usd_cents ?? 0) / 100;
}

/** Test-only seam for direct rate inspection. */
export const _internal = {
  rateFor,
  USD_CENTS_PER_1K_TOKENS,
  DEFAULT_RATE,
};
